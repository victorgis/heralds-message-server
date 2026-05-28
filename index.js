require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const cors = require("cors");
const express = require("express");

const app = express();

const BOT_API_BASE =
  process.env.TELEGRAM_BOT_API_BASE || "https://api.telegram.org";
const TELEGRAM_HOSTED_BOT_API = "https://api.telegram.org";
const TELEGRAM_BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const PORT = Number(process.env.PORT || 4000);
const CACHE_DIR = path.resolve(
  process.env.CACHE_DIR || path.join(__dirname, "cache")
);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400);
const CACHE_MAX_BYTES = Number(
  process.env.CACHE_MAX_BYTES || 2 * 1024 * 1024 * 1024
);
const CACHE_CLEANUP_INTERVAL_SECONDS = Number(
  process.env.CACHE_CLEANUP_INTERVAL_SECONDS || 900
);
const TEMP_SUPABASE_MIRROR_ENABLED =
  process.env.TEMP_SUPABASE_MIRROR_ENABLED === "true";
const TEMP_SUPABASE_BUCKET =
  process.env.TEMP_SUPABASE_BUCKET ||
  process.env.SUPABASE_AUDIO_BUCKET ||
  "audio-messages";
const TEMP_SUPABASE_PREFIX =
  process.env.TEMP_SUPABASE_PREFIX || "temporary-telegram-cache";
const TEMP_SUPABASE_TTL_SECONDS = Number(
  process.env.TEMP_SUPABASE_TTL_SECONDS || CACHE_TTL_SECONDS
);
const TEMP_SUPABASE_MIRROR_MIN_BYTES = Number(
  process.env.TEMP_SUPABASE_MIRROR_MIN_BYTES || TELEGRAM_BOT_DOWNLOAD_LIMIT
);
const activeDownloads = new Map();

app.set("trust proxy", true);
app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      if (
        !origin ||
        !allowedOrigins.length ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  })
);

const jsonResponse = (response, statusCode, body) => {
  response.status(statusCode).set("Cache-Control", "no-store").json(body);
};

const createTraceId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeString = (value, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
};

const getApiBaseUrl = (request) => {
  return (
    process.env.PUBLIC_API_BASE_URL ||
    `${request.protocol}://${request.get("host")}`
  ).replace(/\/$/, "");
};

const getSupabaseConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  return { supabaseUrl, supabaseKey };
};

const getSupabaseAdminConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return { supabaseUrl, supabaseKey };
};

const encodeStoragePath = (storagePath) => {
  return storagePath.split("/").map(encodeURIComponent).join("/");
};

const getPublicStorageUrl = (supabaseUrl, bucket, storagePath) => {
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeStoragePath(
    storagePath
  )}`;
};

const getMirrorMetadataDir = () => path.join(CACHE_DIR, ".metadata");

const getMirrorManifestPath = () =>
  path.join(getMirrorMetadataDir(), "temp-supabase-mirrors.json");

const readMirrorManifest = async () => {
  try {
    const manifest = await fsp.readFile(getMirrorManifestPath(), "utf8");
    return JSON.parse(manifest);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};

const writeMirrorManifest = async (manifest) => {
  await fsp.mkdir(getMirrorMetadataDir(), { recursive: true });
  await fsp.writeFile(
    getMirrorManifestPath(),
    JSON.stringify(manifest, null, 2)
  );
};

const createSignedStorageUrl = async (
  supabaseUrl,
  supabaseKey,
  bucket,
  storagePath
) => {
  const expiresIn = Number(process.env.SUPABASE_STORAGE_SIGNED_URL_TTL || 3600);
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/${bucket}/${encodeStoragePath(
      storagePath
    )}`,
    {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    }
  );

  if (!response.ok) {
    throw new Error(`Supabase storage signing returned ${response.status}`);
  }

  const data = await response.json();
  const signedPath = data.signedURL || data.signedUrl;

  if (!signedPath) {
    throw new Error("Supabase storage signing did not return a signed URL");
  }

  return signedPath.startsWith("http")
    ? signedPath
    : `${supabaseUrl}${signedPath}`;
};

const deleteSupabaseObjects = async (bucket, objectPaths) => {
  const paths = objectPaths.filter(Boolean);
  if (!paths.length) return;

  const { supabaseUrl, supabaseKey } = getSupabaseAdminConfig();
  if (!supabaseUrl || !supabaseKey) return;

  for (const objectPath of paths) {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/${bucket}/${encodeStoragePath(
        objectPath
      )}`,
      {
        method: "DELETE",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Supabase temp delete returned ${response.status} for ${objectPath}`
      );
    }
  }
};

const uploadSupabaseObject = async (bucket, objectPath, filePath) => {
  const { supabaseUrl, supabaseKey } = getSupabaseAdminConfig();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing Supabase URL or service key for temp mirror upload"
    );
  }

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${bucket}/${encodeStoragePath(
      objectPath
    )}`,
    {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": getContentType(filePath),
        "x-upsert": "true",
      },
      body: fs.createReadStream(filePath),
      duplex: "half",
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Supabase temp upload returned ${response.status}: ${detail.slice(
        0,
        160
      )}`
    );
  }
};

const getSignedTempMirrorUrl = async (fileId) => {
  if (!TEMP_SUPABASE_MIRROR_ENABLED) return "";

  const manifest = await readMirrorManifest();
  const mirror = manifest[fileId];

  if (!mirror || mirror.expiresAt <= Date.now()) return "";

  const { supabaseUrl, supabaseKey } = getSupabaseAdminConfig();
  if (!supabaseUrl || !supabaseKey) return "";

  try {
    return await createSignedStorageUrl(
      supabaseUrl,
      supabaseKey,
      mirror.bucket,
      mirror.objectPath
    );
  } catch (error) {
    delete manifest[fileId];
    await writeMirrorManifest(manifest);
    throw error;
  }
};

const uploadTempMirror = async (fileId, cachePath, traceId) => {
  if (!TEMP_SUPABASE_MIRROR_ENABLED) return "";

  const stats = await fsp.stat(cachePath);
  if (stats.size < TEMP_SUPABASE_MIRROR_MIN_BYTES) return "";

  const { supabaseUrl, supabaseKey } = getSupabaseAdminConfig();
  if (!supabaseUrl || !supabaseKey) {
    console.warn(
      `[stream:${traceId}] Temp mirror skipped; missing Supabase config`
    );
    return "";
  }

  const manifest = await readMirrorManifest();
  const existing = manifest[fileId];

  if (existing && existing.expiresAt > Date.now()) {
    return createSignedStorageUrl(
      supabaseUrl,
      supabaseKey,
      existing.bucket,
      existing.objectPath
    );
  }

  const fileHash = crypto.createHash("sha256").update(fileId).digest("hex");
  const extension = path.extname(cachePath) || ".audio";
  const objectPath = `${TEMP_SUPABASE_PREFIX}/${fileHash}${extension}`;

  console.log(`[stream:${traceId}] Uploading temp Supabase mirror`, {
    bucket: TEMP_SUPABASE_BUCKET,
    objectPath,
    size: stats.size,
  });

  await uploadSupabaseObject(TEMP_SUPABASE_BUCKET, objectPath, cachePath);

  manifest[fileId] = {
    bucket: TEMP_SUPABASE_BUCKET,
    objectPath,
    size: stats.size,
    uploadedAt: Date.now(),
    expiresAt: Date.now() + TEMP_SUPABASE_TTL_SECONDS * 1000,
  };
  await writeMirrorManifest(manifest);

  return createSignedStorageUrl(
    supabaseUrl,
    supabaseKey,
    TEMP_SUPABASE_BUCKET,
    objectPath
  );
};

const resolveStorageUrl = async (row, diagnostics) => {
  const explicitUrl = normalizeString(
    row.audio_url ||
      row.storage_url ||
      row.public_url ||
      row.supabase_url ||
      row.stream_url
  );

  if (explicitUrl) {
    diagnostics.storage.explicitUrlRows += 1;
    return explicitUrl;
  }

  const storagePath = normalizeString(
    row.storage_path || row.object_path || row.s3_key || row.path
  );
  const bucket = normalizeString(
    row.storage_bucket || row.bucket || process.env.SUPABASE_AUDIO_BUCKET,
    "audio-messages"
  );

  if (!storagePath) {
    diagnostics.storage.missingPathRows += 1;
    return "";
  }

  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  if (!supabaseUrl) {
    diagnostics.storage.missingConfigRows += 1;
    return "";
  }

  if (process.env.SUPABASE_STORAGE_PUBLIC === "true") {
    diagnostics.storage.publicUrlRows += 1;
    return getPublicStorageUrl(supabaseUrl, bucket, storagePath);
  }

  if (!supabaseKey) {
    diagnostics.storage.missingConfigRows += 1;
    return "";
  }

  diagnostics.storage.signedUrlRows += 1;
  return createSignedStorageUrl(supabaseUrl, supabaseKey, bucket, storagePath);
};

const parseCaption = (caption = "") => {
  return caption.split("\n").reduce((metadata, line) => {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) return metadata;

    const key = line
      .slice(0, separatorIndex)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    const value = line.slice(separatorIndex + 1).trim();

    if (key && value) {
      metadata[key] = value;
    }

    return metadata;
  }, {});
};

const getAudioPayload = (message) => {
  if (message.audio) return message.audio;

  if (message.document && message.document.mime_type?.startsWith("audio/")) {
    return message.document;
  }

  if (message.voice) return message.voice;

  return null;
};

const getStreamUrl = (request, fileId) => {
  const params = new URLSearchParams({ file_id: fileId });
  return `${getApiBaseUrl(request)}/api/telegram-stream?${params.toString()}`;
};

const slugify = (value) => {
  return normalizeString(value, "teaching")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const parseTrackTitle = (rawTitle, fallbackPart) => {
  const title = normalizeString(
    rawTitle,
    `Teaching Track ${fallbackPart}`
  ).replace(/\.(mp3|m4a|ogg|oga|opus|wav|aac)$/i, "");
  const patterns = [
    /^(.*?)\s*[\[(]\s*(?:track|part|pt\.?)\s*0*(\d+)\s*[\])]$/i,
    /^(.*?)\s*[-–—:]\s*(?:track|part|pt\.?)\s*0*(\d+)$/i,
    /^(.*?)\s+(?:track|part|pt\.?)\s*0*(\d+)$/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);

    if (match) {
      return {
        seriesTitle: normalizeString(match[1], title)
          .replace(/[-–—:]+$/g, "")
          .trim(),
        trackTitle: title,
        part: Number(match[2] || fallbackPart),
      };
    }
  }

  return {
    seriesTitle: title,
    trackTitle: title,
    part: Number(fallbackPart),
  };
};

const getDedupeKey = (teaching) => {
  if (teaching.fileUniqueId) return `unique:${teaching.fileUniqueId}`;
  if (teaching.fileId) return `file:${teaching.fileId}`;
  if (teaching.storageUrl) return `storage:${teaching.storageUrl}`;

  return `title:${slugify(teaching.seriesTitle)}:${slugify(
    teaching.trackTitle
  )}:${teaching.part}`;
};

const dedupeTeachings = (teachings, diagnostics) => {
  const seen = new Set();
  const deduped = [];

  for (const teaching of teachings) {
    const key = getDedupeKey(teaching);

    if (seen.has(key)) {
      diagnostics.duplicateRows.push({
        key,
        title: teaching.trackTitle,
        series: teaching.seriesTitle,
      });
      continue;
    }

    seen.add(key);
    deduped.push(teaching);
  }

  return deduped;
};

const summarizeRow = (row) => ({
  id: row.id,
  series: row.series_name || row.series_title || row.series || row.title,
  track: row.track_title || row.message_title,
  hasFileId: Boolean(row.file_id || row.telegram_file_id),
  hasStorageUrl: Boolean(
    row.audio_url ||
      row.storage_url ||
      row.public_url ||
      row.supabase_url ||
      row.stream_url
  ),
  hasStoragePath: Boolean(
    row.storage_path || row.object_path || row.s3_key || row.path
  ),
  storageBucket:
    row.storage_bucket || row.bucket || process.env.SUPABASE_AUDIO_BUCKET,
});

const normalizeTeachingRow = async (row, index, diagnostics) => {
  const fileId = normalizeString(row.file_id || row.telegram_file_id);
  const storageUrl = await resolveStorageUrl(row, diagnostics);

  if (!fileId && !storageUrl) {
    diagnostics.droppedRows.push({
      reason: "missing_file_id_and_storage_url",
      row: summarizeRow(row),
    });
    return null;
  }

  const parsedTitle = parseTrackTitle(
    row.track_title || row.message_title || row.title,
    index + 1
  );
  const seriesTitle = normalizeString(
    row.series_name || row.series_title || row.series,
    parsedTitle.seriesTitle
  );
  const part = Number(row.part || row.part_number || parsedTitle.part);
  const title = normalizeString(
    row.track_title || row.message_title,
    parsedTitle.trackTitle
  );
  const publishedAt = normalizeString(
    row.published_at || row.created_at || row.date
  );

  return {
    id: normalizeString(
      row.id || row.file_unique_id || fileId || storageUrl,
      `teaching-${index}`
    ),
    seriesId: normalizeString(
      row.series_id || row.series_slug,
      slugify(seriesTitle)
    ),
    seriesTitle,
    trackTitle: title,
    part,
    year: Number(
      row.year ||
        (publishedAt
          ? new Date(publishedAt).getFullYear()
          : new Date().getFullYear())
    ),
    type: normalizeString(row.type || row.meeting_type, "Teaching"),
    speaker: normalizeString(row.speaker || row.preacher, "Heralds Nation"),
    duration: normalizeString(row.duration, "Audio"),
    fileSize: Number(row.file_size || row.size || 0),
    fileUniqueId: normalizeString(
      row.file_unique_id || row.telegram_file_unique_id
    ),
    fileId,
    storageUrl,
    description: normalizeString(
      row.description,
      "A recorded teaching from Heralds Nation."
    ),
    cover: normalizeString(row.cover_url || row.artwork_url),
    publishedAt,
  };
};

const normalizeTelegramUpdate = (update, index) => {
  const message =
    update.message ||
    update.channel_post ||
    update.edited_message ||
    update.edited_channel_post;
  if (!message) return null;

  const audio = getAudioPayload(message);
  if (!audio?.file_id) return null;

  const metadata = parseCaption(message.caption || "");
  const date = message.date ? new Date(message.date * 1000) : new Date();
  const fallbackTitle =
    audio.title || audio.file_name || `Teaching Part ${index + 1}`;
  const parsedTitle = parseTrackTitle(
    metadata.title || metadata.track_title || fallbackTitle,
    index + 1
  );
  const seriesTitle = normalizeString(
    metadata.series || metadata.series_name,
    parsedTitle.seriesTitle
  );
  const part = Number(
    metadata.part || metadata.part_number || parsedTitle.part
  );

  return {
    id: normalizeString(
      audio.file_unique_id || audio.file_id,
      `${audio.file_id}-${index}`
    ),
    seriesId: normalizeString(
      metadata.series_id || metadata.series_slug,
      slugify(seriesTitle)
    ),
    seriesTitle,
    trackTitle: normalizeString(
      metadata.title || metadata.track_title,
      parsedTitle.trackTitle
    ),
    part,
    year: Number(metadata.year || date.getFullYear()),
    type: normalizeString(metadata.type || metadata.meeting_type, "Teaching"),
    speaker: normalizeString(
      metadata.speaker || metadata.preacher || audio.performer,
      "Heralds Nation"
    ),
    duration: audio.duration
      ? `${Math.floor(audio.duration / 60)}:${String(
          audio.duration % 60
        ).padStart(2, "0")}`
      : "Audio",
    fileSize: Number(audio.file_size || 0),
    fileUniqueId: normalizeString(audio.file_unique_id),
    fileId: audio.file_id,
    description: normalizeString(
      metadata.description,
      "A recorded teaching from Heralds Nation."
    ),
    cover: normalizeString(metadata.cover || metadata.cover_url),
    publishedAt: date.toISOString(),
  };
};

const groupTeachings = (request, teachings) => {
  const groups = teachings.reduce((seriesMap, teaching) => {
    if (!teaching) return seriesMap;

    if (!seriesMap.has(teaching.seriesId)) {
      seriesMap.set(teaching.seriesId, {
        id: teaching.seriesId,
        title: teaching.seriesTitle,
        year: teaching.year,
        type: teaching.type,
        speaker: teaching.speaker,
        duration: "",
        cover: teaching.cover,
        description: teaching.description,
        publishedAt: teaching.publishedAt,
        tracks: [],
      });
    }

    const series = seriesMap.get(teaching.seriesId);
    series.year = Math.max(series.year, teaching.year);
    series.publishedAt =
      !series.publishedAt ||
      new Date(teaching.publishedAt) > new Date(series.publishedAt)
        ? teaching.publishedAt
        : series.publishedAt;

    if (!series.cover && teaching.cover) {
      series.cover = teaching.cover;
    }

    const requiresLocalBotApi =
      !teaching.storageUrl &&
      teaching.fileId &&
      teaching.fileSize &&
      teaching.fileSize > TELEGRAM_BOT_DOWNLOAD_LIMIT &&
      BOT_API_BASE === TELEGRAM_HOSTED_BOT_API;

    series.tracks.push({
      id: teaching.id,
      title: teaching.trackTitle,
      part: teaching.part,
      duration: teaching.duration,
      fileId: teaching.fileId,
      fileSize: teaching.fileSize,
      audioUrl: requiresLocalBotApi
        ? ""
        : teaching.storageUrl || getStreamUrl(request, teaching.fileId),
      source: teaching.storageUrl
        ? "supabase"
        : requiresLocalBotApi
        ? "telegram-needs-local-bot-api"
        : "telegram-cache",
      unavailableReason: requiresLocalBotApi
        ? "This Telegram file is over 20MB. Set TELEGRAM_BOT_API_BASE to a self-hosted Telegram Bot API server."
        : "",
    });

    return seriesMap;
  }, new Map());

  return [...groups.values()]
    .map((series) => ({
      ...series,
      duration: `${series.tracks.length} ${
        series.tracks.length === 1 ? "message" : "messages"
      }`,
      tracks: series.tracks.sort((first, second) => first.part - second.part),
    }))
    .sort(
      (first, second) =>
        new Date(second.publishedAt || 0) - new Date(first.publishedAt || 0)
    );
};

const fetchFromSupabase = async (diagnostics) => {
  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  const tableName =
    process.env.TELEGRAM_TEACHINGS_TABLE || "telegram_teachings";

  diagnostics.supabase.tableName = tableName;
  diagnostics.supabase.hasUrl = Boolean(supabaseUrl);
  diagnostics.supabase.hasKey = Boolean(supabaseKey);

  if (!supabaseUrl || !supabaseKey) {
    diagnostics.supabase.skipped = "missing_supabase_url_or_key";
    return [];
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/${tableName}?select=*`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase returned ${response.status}`);
  }

  const rows = await response.json();
  diagnostics.supabase.rowCount = rows.length;
  diagnostics.supabase.sampleRows = rows.slice(0, 5).map(summarizeRow);

  const normalizedRows = await Promise.all(
    rows.map((row, index) => normalizeTeachingRow(row, index, diagnostics))
  );
  const teachings = dedupeTeachings(
    normalizedRows.filter(Boolean),
    diagnostics
  );

  diagnostics.supabase.normalizedCount = teachings.length;
  diagnostics.supabase.supabaseAudioCount = teachings.filter(
    (teaching) => teaching.storageUrl
  ).length;
  diagnostics.supabase.telegramAudioCount = teachings.filter(
    (teaching) => !teaching.storageUrl && teaching.fileId
  ).length;

  return teachings;
};

const fetchFromTelegramUpdates = async (botToken, diagnostics) => {
  const response = await fetch(
    `${BOT_API_BASE}/bot${botToken}/getUpdates?allowed_updates=["message","channel_post"]`
  );

  if (!response.ok) {
    throw new Error(`Telegram returned ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || "Telegram getUpdates failed");
  }

  diagnostics.telegram.updateCount = data.result.length;
  const teachings = dedupeTeachings(
    data.result.map(normalizeTelegramUpdate).filter(Boolean),
    diagnostics
  );
  diagnostics.telegram.normalizedCount = teachings.length;

  return teachings;
};

const ensureCacheDir = async () => {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
};

const getCachedFiles = async () => {
  await ensureCacheDir();
  const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;

    const filePath = path.join(CACHE_DIR, entry.name);
    const stats = await fsp.stat(filePath);
    files.push({
      filePath,
      name: entry.name,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }

  return files;
};

const cleanupCache = async () => {
  const now = Date.now();
  const maxAgeMs = CACHE_TTL_SECONDS * 1000;
  let files = await getCachedFiles();

  for (const file of files) {
    if (now - file.mtimeMs > maxAgeMs) {
      await fsp.rm(file.filePath, { force: true });
    }
  }

  files = await getCachedFiles();
  let totalSize = files.reduce((sum, file) => sum + file.size, 0);

  if (totalSize <= CACHE_MAX_BYTES) return;

  const oldestFirst = files.sort(
    (first, second) => first.mtimeMs - second.mtimeMs
  );

  for (const file of oldestFirst) {
    if (totalSize <= CACHE_MAX_BYTES) break;

    await fsp.rm(file.filePath, { force: true });
    totalSize -= file.size;
  }
};

const cleanupTempMirrors = async () => {
  if (!TEMP_SUPABASE_MIRROR_ENABLED) return;

  const manifest = await readMirrorManifest();
  const expiredFileIds = Object.entries(manifest)
    .filter(([, mirror]) => mirror.expiresAt <= Date.now())
    .map(([fileId]) => fileId);

  if (!expiredFileIds.length) return;

  const expiredMirrors = expiredFileIds.map((fileId) => manifest[fileId]);
  const mirrorsByBucket = expiredMirrors.reduce((buckets, mirror) => {
    buckets[mirror.bucket] = buckets[mirror.bucket] || [];
    buckets[mirror.bucket].push(mirror.objectPath);
    return buckets;
  }, {});

  for (const [bucket, objectPaths] of Object.entries(mirrorsByBucket)) {
    await deleteSupabaseObjects(bucket, objectPaths);
  }

  for (const fileId of expiredFileIds) {
    delete manifest[fileId];
  }

  await writeMirrorManifest(manifest);
};

const getCachePath = async (fileId, extension = ".audio") => {
  await ensureCacheDir();
  const hash = crypto.createHash("sha256").update(fileId).digest("hex");
  const files = await fsp.readdir(CACHE_DIR);
  const existing = files.find(
    (file) => file.startsWith(`${hash}.`) && !file.endsWith(".tmp")
  );

  if (existing) {
    return path.join(CACHE_DIR, existing);
  }

  return path.join(CACHE_DIR, `${hash}${extension}`);
};

const getExtensionFromFilePath = (filePath = "") => {
  const extension = path.extname(filePath.split("?")[0]);
  return extension || ".audio";
};

const resolveTelegramFile = async (fileId) => {
  const response = await fetch(
    `${BOT_API_BASE}/bot${
      process.env.TELEGRAM_BOT_TOKEN
    }/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const data = await response.json();

  if (!response.ok || !data.ok || !data.result?.file_path) {
    const telegramMessage =
      data.description || "Unable to resolve Telegram file";
    const isTooBig = telegramMessage.toLowerCase().includes("file is too big");
    const error = new Error(telegramMessage);
    error.statusCode = isTooBig ? 413 : 502;
    error.isTooBig = isTooBig;
    throw error;
  }

  return data.result;
};

const downloadTelegramFileToCache = async (fileId, traceId) => {
  if (activeDownloads.has(fileId)) {
    return activeDownloads.get(fileId);
  }

  const downloadPromise = (async () => {
    const file = await resolveTelegramFile(fileId);
    const extension = getExtensionFromFilePath(file.file_path);
    const cachePath = await getCachePath(fileId, extension);

    try {
      const stats = await fsp.stat(cachePath);
      await fsp.utimes(cachePath, new Date(), new Date());
      return { cachePath, size: stats.size, filePath: file.file_path };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const tempPath = `${cachePath}.tmp`;

    // --- THE FIX ---
    // If using the local API server, 'file.file_path' is an absolute path on disk.
    // It is NOT served over HTTP.
    if (path.isAbsolute(file.file_path)) {
      console.log(
        `[stream:${traceId}] Cache miss; copying from local Bot API disk`,
        {
          sourcePath: file.file_path,
          cachePath,
        }
      );
      // Copy directly from the local API server's file storage
      await fsp.copyFile(file.file_path, tempPath);
      await fsp.rename(tempPath, cachePath);
    } else {
      // Fallback for cloud API (standard 20MB limit)
      const fileUrl = `${BOT_API_BASE}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);

      if (!response.ok || !response.body) {
        throw new Error(`Telegram file download returned ${response.status}`);
      }

      console.log(`[stream:${traceId}] Cache miss; downloading via HTTP`, {
        filePath: file.file_path,
        cachePath,
      });

      await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(tempPath)
      );
      await fsp.rename(tempPath, cachePath);
    }

    await cleanupCache();

    const stats = await fsp.stat(cachePath);
    return { cachePath, size: stats.size, filePath: file.file_path };
  })();

  activeDownloads.set(fileId, downloadPromise);

  try {
    return await downloadPromise;
  } finally {
    activeDownloads.delete(fileId);
  }
};

const getContentType = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".ogg" || extension === ".oga" || extension === ".opus")
    return "audio/ogg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".aac") return "audio/aac";

  return "application/octet-stream";
};

const streamCachedFile = async (request, response, cachePath) => {
  const stats = await fsp.stat(cachePath);
  const range = request.headers.range;
  await fsp.utimes(cachePath, new Date(), new Date());

  response.set({
    "Accept-Ranges": "bytes",
    "Content-Type": getContentType(cachePath),
    "Cache-Control": "private, max-age=3600",
  });

  if (!range) {
    response.set({
      "Content-Length": stats.size,
    });
    fs.createReadStream(cachePath).pipe(response);
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    response.status(416).end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stats.size - 1;

  if (start >= stats.size || end >= stats.size || start > end) {
    response.status(416).set("Content-Range", `bytes */${stats.size}`).end();
    return;
  }

  response.status(206).set({
    "Content-Range": `bytes ${start}-${end}/${stats.size}`,
    "Content-Length": end - start + 1,
  });
  fs.createReadStream(cachePath, { start, end }).pipe(response);
};

app.get("/health", (request, response) => {
  jsonResponse(response, 200, {
    ok: true,
    botApiBase: BOT_API_BASE,
    cacheDir: CACHE_DIR,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    cacheMaxBytes: CACHE_MAX_BYTES,
    tempSupabaseMirrorEnabled: TEMP_SUPABASE_MIRROR_ENABLED,
    tempSupabaseBucket: TEMP_SUPABASE_BUCKET,
    tempSupabasePrefix: TEMP_SUPABASE_PREFIX,
    tempSupabaseTtlSeconds: TEMP_SUPABASE_TTL_SECONDS,
  });
});

app.get("/api/teachings", async (request, response) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const debug = request.query.debug === "1";
  const traceId = createTraceId();
  const diagnostics = {
    traceId,
    source: "none",
    botApiBase: BOT_API_BASE,
    usesHostedBotApi: BOT_API_BASE === TELEGRAM_HOSTED_BOT_API,
    supabase: {},
    storage: {
      explicitUrlRows: 0,
      publicUrlRows: 0,
      signedUrlRows: 0,
      missingPathRows: 0,
      missingConfigRows: 0,
    },
    telegram: {},
    droppedRows: [],
    duplicateRows: [],
  };

  try {
    console.log(`[teachings:${traceId}] Loading teachings`);
    diagnostics.telegram.hasBotToken = Boolean(botToken);
    let teachings = await fetchFromSupabase(diagnostics);
    diagnostics.source = teachings.length ? "supabase" : "none";

    if (!teachings.length && botToken) {
      console.log(
        `[teachings:${traceId}] No Supabase teachings found; falling back to Telegram`
      );
      teachings = await fetchFromTelegramUpdates(botToken, diagnostics);
      diagnostics.source = teachings.length ? "telegram" : "none";
    } else if (!teachings.length && !botToken) {
      diagnostics.telegram.skipped = "missing_telegram_bot_token";
    }

    const teachingCountBeforeDedupe = teachings.length;
    teachings = dedupeTeachings(teachings, diagnostics);
    diagnostics.dedupe = {
      before: teachingCountBeforeDedupe,
      after: teachings.length,
      duplicatesRemoved: teachingCountBeforeDedupe - teachings.length,
    };

    const series = groupTeachings(request, teachings);
    diagnostics.seriesCount = series.length;
    diagnostics.trackCount = series.reduce(
      (count, item) => count + item.tracks.length,
      0
    );
    diagnostics.trackSourceCounts = series
      .flatMap((item) => item.tracks)
      .reduce(
        (counts, track) => ({
          ...counts,
          [track.source]: (counts[track.source] || 0) + 1,
        }),
        {}
      );
    diagnostics.unstreamableTracks = series
      .flatMap((item) =>
        item.tracks.map((track) => ({ ...track, seriesTitle: item.title }))
      )
      .filter((track) => !track.audioUrl)
      .map((track) => ({
        series: track.seriesTitle,
        title: track.title,
        source: track.source,
        fileSize: track.fileSize,
        unavailableReason: track.unavailableReason,
      }));

    console.log(`[teachings:${traceId}] Diagnostics`, diagnostics);

    jsonResponse(response, 200, {
      source: diagnostics.source,
      traceId,
      series,
      ...(debug ? { diagnostics } : {}),
    });
  } catch (error) {
    console.error(`[teachings:${traceId}] Failed`, error);
    jsonResponse(response, 500, {
      message: "Unable to load teachings",
      detail: error.message,
      traceId,
      ...(debug ? { diagnostics } : {}),
    });
  }
});

app.get("/api/telegram-stream", async (request, response) => {
  const traceId = createTraceId();
  const fileId = normalizeString(request.query.file_id);
  const safeFileId = fileId
    ? `${fileId.slice(0, 8)}...${fileId.slice(-6)}`
    : "missing";

  console.log(`[stream:${traceId}] Stream request`, {
    fileId: safeFileId,
    range: request.headers.range || "none",
    botApiBase: BOT_API_BASE,
  });

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    jsonResponse(response, 500, {
      message: "Missing TELEGRAM_BOT_TOKEN",
      traceId,
    });
    return;
  }

  if (!fileId) {
    jsonResponse(response, 400, { message: "Missing file_id", traceId });
    return;
  }

  try {
    const mirroredUrl = await getSignedTempMirrorUrl(fileId);

    if (mirroredUrl) {
      console.log(`[stream:${traceId}] Redirecting to temp Supabase mirror`, {
        fileId: safeFileId,
      });
      response.status(307).set("Location", mirroredUrl).end();
      return;
    }

    const cachedFile = await downloadTelegramFileToCache(fileId, traceId);
    const newMirroredUrl = await uploadTempMirror(
      fileId,
      cachedFile.cachePath,
      traceId
    );

    if (newMirroredUrl) {
      console.log(
        `[stream:${traceId}] Redirecting to new temp Supabase mirror`,
        {
          fileId: safeFileId,
          size: cachedFile.size,
        }
      );
      response.status(307).set("Location", newMirroredUrl).end();
      return;
    }

    console.log(`[stream:${traceId}] Serving cached file`, {
      cachePath: cachedFile.cachePath,
      size: cachedFile.size,
    });
    await streamCachedFile(request, response, cachedFile.cachePath);
  } catch (error) {
    console.error(`[stream:${traceId}] Failed`, {
      message: error.message,
      statusCode: error.statusCode,
      isTooBig: error.isTooBig,
    });

    jsonResponse(response, error.statusCode || 500, {
      message: error.message,
      traceId,
      hint: error.isTooBig
        ? "The hosted Telegram Bot API still has the 20MB limit. Set TELEGRAM_BOT_API_BASE to a self-hosted local Bot API server."
        : undefined,
    });
  }
});

ensureCacheDir()
  .then(async () => {
    await cleanupCache();
    await cleanupTempMirrors();
  })
  .catch((error) => console.error("Initial cache cleanup failed", error));

setInterval(() => {
  Promise.all([cleanupCache(), cleanupTempMirrors()]).catch((error) =>
    console.error("Scheduled cache cleanup failed", error)
  );
}, CACHE_CLEANUP_INTERVAL_SECONDS * 1000).unref();

app.listen(PORT, () => {
  console.log(`Heralds audio server listening on port ${PORT}`);
  console.log(`Telegram Bot API base: ${BOT_API_BASE}`);
  console.log(`Cache dir: ${CACHE_DIR}`);
});

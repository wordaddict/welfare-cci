const crypto = require('crypto');
const { fetchCloudinaryBuffer, hasCloudinaryConfig, uploadBufferToCloudinary } = require('./cloudinary');

function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function createStorageKey(originalName) {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${sanitizeFilename(originalName)}`;
}

async function saveUploadedFile(db, file, options = {}) {
  if (!file || !file.buffer) return null;

  const storageKey = createStorageKey(file.originalname);
  if (hasCloudinaryConfig()) {
    const asset = await uploadBufferToCloudinary(file.buffer, file, options.folder || 'uploads');
    await db.run(
      `INSERT INTO stored_files (
        storage_key, provider, original_name, mime_type, size_bytes, cloud_public_id, cloud_resource_type, cloud_version, secure_url
      ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [storageKey, 'cloudinary', file.originalname, file.mimetype, file.size, asset.publicId, asset.resourceType, asset.version, asset.secureUrl]
    );
  } else {
    await db.run(
      'INSERT INTO stored_files (storage_key, provider, original_name, mime_type, size_bytes, data) VALUES (?,?,?,?,?,?)',
      [storageKey, 'database', file.originalname, file.mimetype, file.size, file.buffer]
    );
  }

  return {
    storageKey,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size
  };
}

async function getStoredFileByKey(db, storageKey) {
  if (!storageKey) return null;
  return db.get('SELECT * FROM stored_files WHERE storage_key=?', storageKey);
}

async function getStoredFileBuffer(fileRecord) {
  if (!fileRecord) return null;
  if (fileRecord.provider === 'cloudinary') {
    return fetchCloudinaryBuffer(fileRecord);
  }
  return Buffer.isBuffer(fileRecord.data) ? fileRecord.data : Buffer.from(fileRecord.data || '');
}

async function sendStoredFile(res, fileRecord, downloadName) {
  if (!fileRecord) return false;
  const safeName = sanitizeFilename(downloadName || fileRecord.original_name || fileRecord.storage_key);
  const disposition = /^application\/pdf$|^image\//.test(fileRecord.mime_type) ? 'inline' : 'attachment';
  const buffer = await getStoredFileBuffer(fileRecord);
  res.type(fileRecord.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName.replace(/"/g, '')}"`);
  res.send(buffer);
  return true;
}

async function appendStoredFileToArchive(archive, fileRecord, archivePath) {
  if (!fileRecord) return;
  const buffer = await getStoredFileBuffer(fileRecord);
  archive.append(buffer, { name: archivePath });
}

module.exports = { appendStoredFileToArchive, getStoredFileByKey, saveUploadedFile, sendStoredFile };

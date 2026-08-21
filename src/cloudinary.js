const { v2: cloudinary } = require('cloudinary');
const { getAppConfig } = require('./config');

let configured = false;

function hasCloudinaryConfig() {
  const config = getAppConfig();
  return config.storage.provider === 'cloudinary';
}

function ensureCloudinaryConfig() {
  if (!hasCloudinaryConfig()) {
    throw new Error('Cloudinary is not configured.');
  }
  if (configured) return;
  const config = getAppConfig();
  cloudinary.config({
    cloud_name: config.storage.cloudinary.cloudName,
    api_key: config.storage.cloudinary.apiKey,
    api_secret: config.storage.cloudinary.apiSecret
  });
  configured = true;
}

function buildFolder(folder) {
  const config = getAppConfig();
  const prefix = config.storage.cloudinary.folderPrefix || 'cci-welfare';
  return [prefix, folder].filter(Boolean).join('/');
}

function resolveResourceType(file) {
  if (file.mimetype && file.mimetype.startsWith('image/')) return 'image';
  return 'raw';
}

async function uploadBufferToCloudinary(buffer, file, folder = 'uploads') {
  ensureCloudinaryConfig();
  const resourceType = resolveResourceType(file);
  const uploadOptions = {
    folder: buildFolder(folder),
    resource_type: resourceType,
    type: 'upload'
  };

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      if (!result) return reject(new Error('Cloudinary upload failed.'));
      resolve({
        publicId: result.public_id,
        secureUrl: result.secure_url,
        bytes: result.bytes,
        version: result.version || null,
        resourceType: result.resource_type || resourceType
      });
    }).end(buffer);
  });
}

async function fetchCloudinaryBuffer(fileRecord) {
  const url = fileRecord.secure_url || cloudinary.url(fileRecord.cloud_public_id, {
    secure: true,
    resource_type: fileRecord.cloud_resource_type || 'raw',
    type: 'upload',
    version: fileRecord.cloud_version || undefined
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Cloudinary asset ${fileRecord.cloud_public_id}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { fetchCloudinaryBuffer, hasCloudinaryConfig, uploadBufferToCloudinary };

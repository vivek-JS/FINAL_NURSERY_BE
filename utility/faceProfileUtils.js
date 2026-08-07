import { decryptFaceDescriptor } from "../utility/faceEncryption.js";

/** Decrypts an EmployeeFaceProfile record into a plain number[] for the face service. */
export function decryptProfileEmbedding(profile) {
  const descriptor = decryptFaceDescriptor({
    encryptedVector: profile.face_embedding_enc,
    iv: profile.iv,
    authTag: profile.authTag,
  });
  return Array.from(descriptor);
}

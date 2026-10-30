/**
 * Baileys auth state backed by MongoDB (replacement for file-based useMultiFileAuthState).
 * Batched reads ($in) and writes (bulkWrite) — signal key churn is the hot path.
 */
import { BufferJSON, initAuthCreds, proto } from "baileys";
import WhatsAppSessionKey from "../../models/whatsappSessionKey.model.js";

const CREDS_KEY = "creds";

const docId = (sessionId, key) => `${sessionId}:${key}`;
const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw) => JSON.parse(raw, BufferJSON.reviver);

async function readCreds(sessionId) {
  const doc = await WhatsAppSessionKey.findById(docId(sessionId, CREDS_KEY)).select("data").lean();
  if (!doc?.data) return null;
  try {
    return decode(doc.data);
  } catch {
    return null;
  }
}

/** True when a linked (scanned) login exists for this session. */
export async function hasStoredWhatsAppSession(sessionId) {
  const creds = await readCreds(sessionId);
  return Boolean(creds?.me?.id);
}

export async function clearWhatsAppSession(sessionId) {
  const { deletedCount } = await WhatsAppSessionKey.deleteMany({ sessionId });
  return deletedCount || 0;
}

export async function useMongoAuthState(sessionId) {
  const creds = (await readCreds(sessionId)) || initAuthCreds();

  const keys = {
    async get(type, ids) {
      const result = {};
      if (!ids?.length) return result;
      const docIds = ids.map((id) => docId(sessionId, `${type}-${id}`));
      const docs = await WhatsAppSessionKey.find({ _id: { $in: docIds } }).select("data").lean();
      const byId = new Map(docs.map((d) => [d._id, d.data]));
      ids.forEach((id, i) => {
        const raw = byId.get(docIds[i]);
        let value = raw ? decode(raw) : null;
        if (value && type === "app-state-sync-key") {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[id] = value;
      });
      return result;
    },

    async set(data) {
      const ops = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const _id = docId(sessionId, `${type}-${id}`);
          const value = data[type][id];
          ops.push(
            value
              ? {
                  updateOne: {
                    filter: { _id },
                    update: { $set: { sessionId, data: encode(value) } },
                    upsert: true,
                  },
                }
              : { deleteOne: { filter: { _id } } }
          );
        }
      }
      if (ops.length) await WhatsAppSessionKey.bulkWrite(ops, { ordered: false });
    },
  };

  const saveCreds = () =>
    WhatsAppSessionKey.updateOne(
      { _id: docId(sessionId, CREDS_KEY) },
      { $set: { sessionId, data: encode(creds) } },
      { upsert: true }
    );

  return { state: { creds, keys }, saveCreds };
}

import { MongoClient } from "mongodb";
import { createMongoDBOIDCPlugin } from "@mongodb-js/oidc-plugin";

// ─── Connection Config (same as mongoExecutor.ts) ───
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://stay-mi-prod-01.9mq2r.mongodb.net/admin?loadBalanced=false&srvServiceName=mongodb&connectTimeoutMS=10000&readPreference=secondary&authSource=%24external&authMechanism=MONGODB-OIDC";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "Stay-MI-Prod-01";

// OIDC plugin — handles browser-based device code flow + token caching (same as mongosh)
const oidcPlugin = createMongoDBOIDCPlugin();

async function connect() {
  console.log(`Connecting to ${MONGO_DB_NAME} via OIDC...`);
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 5,
    minPoolSize: 1,
    ...oidcPlugin.mongoClientOptions,
  });
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(`✅ Connected to ${MONGO_DB_NAME}`);
  return client;
}

async function runQueries(db) {
  const count = await db.collection("accounts").estimatedDocumentCount();
  console.log(`Total accounts (estimated): ${count}`);
}

// ─── Main ───
(async () => {
  let client;
  try {
    client = await connect();
    const db = client.db(MONGO_DB_NAME);
    await runQueries(db);
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    if (client) {
      await client.close();
      console.log("Connection closed.");
    }
  }
})();

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function createTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
    WITH (OIDS=FALSE);
    
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `;
  try {
    await pool.query(query);
    console.log('Session table created successfully');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
createTable();

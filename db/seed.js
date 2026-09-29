import pg from "pg";

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function seed() {
  try {
    console.log("🌱 Upserting CHOXA INTERNET hotspot plans...");

    // Ensure columns exist on plans table and mikrotik_profile is wide enough
    await db.query(`
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS duration_str VARCHAR(50);
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS shared_users INTEGER DEFAULT 1;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS mikrotik_profile VARCHAR(255);
      ALTER TABLE plans ALTER COLUMN mikrotik_profile TYPE VARCHAR(255);
      ALTER TABLE plans ALTER COLUMN duration_days TYPE NUMERIC(8, 2);
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pin VARCHAR(50);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_pin ON subscriptions (pin);
    `);

    await db.query(`
      INSERT INTO plans (id, name, price, duration_days, duration_str, speed_limit, shared_users, mikrotik_profile) VALUES
      (1, '1 Hour', 200, 0.04,  '0d 01:00:00', '15M/15M', 1, 'profile_Hour-se:-co:200-pr:-lu:7-lp:7-ut:0d 01:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (2, '1 Day', 500, 1.00,  '1d 00:00:00', '15M/15M', 1, 'profile_DAY-se:-co:500-pr:-lu:7-lp:7-ut:1d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (3, '1 Week', 2700, 7.00,  '7d 00:00:00', '15M/5M',  1, 'profile_Week-se:-co:2700-pr:-lu:7-lp:7-ut:7d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (4, '1 Week (2 Devices)', 5000, 7.00,  '7d 00:00:00', '15M/15M', 2, 'profile_Week(2)-se:-co:5000-pr:-lu:7-lp:7-ut:7d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (5, '1 Month',10000, 31.00,  '31d 00:00:00', '15M/15M', 1, 'profile_Month-se:-co:10000-pr:-lu:7-lp:7-ut:31d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (6, '1 Month (2 Devices)',18000,31.00,  '31d 00:00:00', '15M/15M', 2, 'profile_Month(2)-se:-co:18000-pr:-lu:7-lp:7-ut:31d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2'),
      (7, '1 Month (3 Devices)',25500,31.00,  '31d 00:00:00', '15M/15M', 3, 'profile_Month(3)-se:-co:25500-pr:-lu:7-lp:7-ut:31d 00:00:00-bt:-kt:false-nu:true-np:true-tp:2')
      ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          price = EXCLUDED.price,
          duration_days = EXCLUDED.duration_days,
          duration_str = EXCLUDED.duration_str,
          speed_limit = EXCLUDED.speed_limit,
          shared_users = EXCLUDED.shared_users,
          mikrotik_profile = EXCLUDED.mikrotik_profile
    `);

    // Reset primary key sequence to start after highest id
    await db.query("SELECT setval('plans_id_seq', (SELECT COALESCE(MAX(id), 1) FROM plans))");

    console.log("✅ CHOXA INTERNET plans seeded successfully!");
  } catch (e) {
    console.error("❌ Error seeding database:", e);
  } finally {
    await db.end();
  }
}

seed();

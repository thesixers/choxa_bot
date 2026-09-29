-- ENUM Types (safe idempotent creation — won't error if types already exist)
DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active', 'inactive', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE subscription_status AS ENUM ('active', 'expired', 'cancelled', 'queued');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'queued'; EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE session_state AS ENUM (
        'start',
        'awaiting_service_selection',
        'awaiting_plan_selection',
        'awaiting_payment',
        'awaiting_support_message',
        'awaiting_hotspot_username',
        'awaiting_hotspot_password',
        'awaiting_new_username',
        'awaiting_new_password',
        'awaiting_device_selection'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add session states if missing
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_service_selection'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_support_message'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_password'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_password'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_device_selection'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_purchase_target'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_gift_username'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_username_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_hotspot_password_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_username_confirm'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'awaiting_new_password_confirm'; EXCEPTION WHEN others THEN NULL; END $$;

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(200) UNIQUE,
    name VARCHAR(225),
    hotspot_username VARCHAR(50),   -- User-chosen MikroTik hotspot username
    hotspot_password VARCHAR(100),  -- User-chosen MikroTik hotspot password
    status user_status DEFAULT 'active',
    flutterwave_customer_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_hotspot_username ON users (hotspot_username) WHERE hotspot_username IS NOT NULL;

-- Plans Table
CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(225),
    price INTEGER,
    duration_days NUMERIC(8, 2),
    duration_str VARCHAR(50),
    data_limit_mb INTEGER,
    speed_limit VARCHAR(100),
    shared_users INTEGER DEFAULT 1,
    mikrotik_profile VARCHAR(255) -- Full MikroTik hotspot profile name
);

-- Payments Table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    amount INTEGER,
    status payment_status DEFAULT 'pending',
    provider VARCHAR(225),
    method VARCHAR(20) DEFAULT 'transfer',  -- 'transfer' | 'cash' (admin manual activation)
    virtual_account_reference VARCHAR(100) UNIQUE, -- UUID from FLW dynamic VA; used for webhook lookup
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP
);

-- Subscriptions Table (Hotspot Tickets)
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    plan_id INTEGER REFERENCES plans(id),
    pin VARCHAR(50) UNIQUE,                  -- MikroTik Hotspot Ticket / Login PIN
    status subscription_status DEFAULT 'active',
    start_time TIMESTAMP,                    -- NULL until first login activation
    expiry_time TIMESTAMP,                   -- NULL until first login activation
    data_used_mb INTEGER DEFAULT 0,
    alert_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_pin ON subscriptions (pin);

-- Chat Sessions Table
CREATE TABLE IF NOT EXISTS chat_sessions (
    phone VARCHAR(200) PRIMARY KEY,
    state session_state DEFAULT 'start',
    plan_id INTEGER REFERENCES plans(id),
    remote_jid VARCHAR(100),              -- WhatsApp JID
    telegram_chat_id VARCHAR(100),        -- Telegram Chat ID
    preferred_platform VARCHAR(20) DEFAULT 'whatsapp', -- 'whatsapp' | 'telegram'
    gift_target_user_id INT REFERENCES users(id),
    pending_username VARCHAR(50),
    pending_password VARCHAR(10),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Provisioning Queue Table
CREATE TABLE IF NOT EXISTS provisioning_queue (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER REFERENCES users(id),
    phone            VARCHAR(200) NOT NULL,
    mikrotik_profile VARCHAR(100) NOT NULL,
    plan_name        VARCHAR(225),
    pin              VARCHAR(10) NOT NULL,        -- Pre-generated PIN
    attempts         INTEGER DEFAULT 0,
    max_attempts     INTEGER DEFAULT 10,
    status           VARCHAR(20) DEFAULT 'pending', -- pending | completed | abandoned
    next_retry_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_attempted_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prov_queue_pending ON provisioning_queue (status, next_retry_at);

-- Offline Message Queue Table
CREATE TABLE IF NOT EXISTS message_queue (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(200) NOT NULL,
    message_text TEXT NOT NULL,
    send_to_both BOOLEAN DEFAULT false,
    attempts INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending', -- pending | failed | sent
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_attempted_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_queue_pending ON message_queue (status, created_at);

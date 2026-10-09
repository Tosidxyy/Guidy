-- Local development delivery only. No public mailbox endpoint or production delivery.
CREATE TABLE dev_auth_inbox (
    email TEXT PRIMARY KEY NOT NULL,
    otp TEXT NOT NULL CHECK(length(otp) = 6 AND otp NOT GLOB '*[^0-9]*'),
    expires_at INTEGER NOT NULL CHECK(expires_at >= 0)
) STRICT;

-- Better Auth database rate limiter; fields follow the locked library schema.
CREATE TABLE "rateLimit" (
    id TEXT PRIMARY KEY NOT NULL,
    key TEXT NOT NULL UNIQUE,
    count INTEGER NOT NULL,
    lastRequest INTEGER NOT NULL
);

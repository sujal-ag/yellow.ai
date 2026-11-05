-- Scheduled notification dispatcher: hand-written schema (MySQL 8).
-- All DATETIME(3) values are UTC with millisecond precision; compare with NOW(3).

CREATE TABLE IF NOT EXISTS tenants (
  id                  BIGINT       NOT NULL,
  -- N: max provider sends per second for this tenant, across all workers.
  rate_limit_per_sec  INT          NOT NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_tenants_rate CHECK (rate_limit_per_sec > 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;


CREATE TABLE IF NOT EXISTS campaigns (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT       NOT NULL,
  channel     ENUM('sms', 'whatsapp', 'email') NOT NULL,
  send_at     DATETIME(3)  NOT NULL,
  -- Stored status only records the user's intent. "running" / "completed" are
  -- derived from message counts at read time, so they can never drift.
  status      ENUM('scheduled', 'cancelled') NOT NULL DEFAULT 'scheduled',
  cancelled_at DATETIME(3) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_campaigns_tenant (tenant_id),
  CONSTRAINT fk_campaigns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;


-- One row per (campaign, recipient). This table IS the work queue.
CREATE TABLE IF NOT EXISTS messages (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  campaign_id      BIGINT       NOT NULL,
  -- Denormalised from campaigns so the worker can rate-limit without a join.
  tenant_id        BIGINT       NOT NULL,
  user_id          VARCHAR(64)  NOT NULL,

  status           ENUM('pending', 'in_progress', 'sent', 'failed', 'cancelled')
                                NOT NULL DEFAULT 'pending',
  attempts         INT          NOT NULL DEFAULT 0,

  -- Earliest time this message may be claimed. Initialised to the campaign's
  -- send_at; retries only ever push it later (backoff). So the single claim
  -- predicate `next_attempt_at <= NOW(3)` enforces BOTH "no early send" and backoff.
  next_attempt_at  DATETIME(3)  NOT NULL,

  -- Lease: while status = 'in_progress', the claim owning this row is valid until
  -- lease_until. After that, any worker may reclaim it (crash recovery).
  lease_until      DATETIME(3)  NULL,
  -- Fencing token of the current claim. Every result write is guarded by
  -- `WHERE claim_token = ?`, so a worker that lost its lease cannot overwrite.
  claim_token      CHAR(36)     NULL,

  last_error       VARCHAR(255) NULL,
  sent_at          DATETIME(3)  NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),

  -- Rule 1 at the data level: a recipient can appear in a campaign only once.
  -- The provider Idempotency-Key is "{campaign_id}:{user_id}", so this also
  -- guarantees one key per message.
  UNIQUE KEY uq_messages_campaign_user (campaign_id, user_id),

  -- Claim, branch 1: due pending messages.
  KEY idx_messages_due (status, next_attempt_at),
  -- Claim, branch 2: in_progress messages whose lease expired (dead worker).
  KEY idx_messages_lease (status, lease_until),
  -- GET /campaigns/:id counts: COUNT(*) ... WHERE campaign_id = ? GROUP BY status.
  KEY idx_messages_campaign_status (campaign_id, status),

  CONSTRAINT fk_messages_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
  CONSTRAINT chk_messages_attempts CHECK (attempts >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

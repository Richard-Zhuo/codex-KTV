-- Explicit operator-confirmed mappings only. No production device seed.
CREATE TABLE room_device_mappings (
  ledger_id VARCHAR(64) NOT NULL,
  internal_room_id VARCHAR(191) NOT NULL,
  provider VARCHAR(191) NOT NULL,
  external_device_id VARCHAR(191) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (ledger_id, internal_room_id),
  UNIQUE KEY room_device_target (ledger_id, provider, external_device_id),
  CONSTRAINT room_device_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

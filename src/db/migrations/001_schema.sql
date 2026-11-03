CREATE TABLE empresas (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  cuit                    VARCHAR(11) NOT NULL UNIQUE,
  razon_social            VARCHAR(255) NOT NULL,
  p12_data                LONGBLOB NOT NULL,
  p12_password_encrypted  VARCHAR(500) NOT NULL,
  api_key                 VARCHAR(64) NOT NULL UNIQUE,
  activo                  BOOLEAN DEFAULT TRUE,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE token_cache (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL UNIQUE,
  token       TEXT NOT NULL,
  sign        TEXT NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE TABLE facturas_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL,
  endpoint    VARCHAR(100) COMMENT 'Ruta HTTP del request, ej: /api/v1/factura/emitir',
  request     JSON,
  response    JSON,
  cae         VARCHAR(20),
  resultado   VARCHAR(1) COMMENT 'A=aprobado, R=rechazado, P=parcial',
  error       TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE INDEX idx_facturas_log_empresa ON facturas_log(empresa_id);
CREATE INDEX idx_facturas_log_cae ON facturas_log(cae);

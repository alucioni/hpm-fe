-- Tokens WSAA de servicios distintos de wsfe (por ahora ws_sr_padron_a13). token_cache tiene
-- UNIQUE(empresa_id) y lo usa wsfe: un token de otro servicio ahi pisaria el de facturacion.
-- WSAA no entrega un TA nuevo mientras el anterior siga vigente, por eso se persiste (un
-- cache en memoria se perderia al reiniciar y el servicio quedaria sin token hasta 12 h).

CREATE TABLE token_cache_servicio (
  empresa_id  INT NOT NULL,
  servicio    VARCHAR(50) NOT NULL,
  token       TEXT NOT NULL,
  sign        TEXT NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (empresa_id, servicio),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

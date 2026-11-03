-- Idempotencia de emisión: una fila por (empresa_id, clave). La clave que manda HPM es
-- el id de orden_compra_entrega_cab. Se "reclama" la clave (INSERT estado='en_curso')
-- ANTES de llamar a AFIP; el índice único evita que dos requests simultáneos emitan dos
-- comprobantes. Al obtener CAE se pasa a estado='listo'; si AFIP rechaza o falla la
-- llamada, la fila se borra para permitir el reintento.

CREATE TABLE emisiones_idempotencia (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  empresa_id          INT NOT NULL,
  clave               VARCHAR(64) NOT NULL,
  estado              VARCHAR(10) NOT NULL DEFAULT 'en_curso' COMMENT 'en_curso | listo',
  cae                 VARCHAR(20),
  vencimiento_cae     VARCHAR(8),
  numero_comprobante  BIGINT,
  resultado           VARCHAR(1),
  punto_vta           INT,
  tipo_cbte           INT,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emisiones_empresa_clave (empresa_id, clave),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

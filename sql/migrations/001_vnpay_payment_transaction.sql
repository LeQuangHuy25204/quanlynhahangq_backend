-- Migration 001: Thêm bảng paymenttransaction lưu lịch sử giao dịch VNPay
-- An toàn cho dữ liệu hiện có, không xóa hoặc làm mất dữ liệu bảng payment cũ.
-- Chạy thủ công trên MySQL Local hoặc Railway MySQL trước khi deploy bản mới.

SET @db_name = DATABASE();

-- 1. Bổ sung cột UpdatedAt vào bảng payment nếu chưa có
SET @has_updated_at = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'payment'
    AND COLUMN_NAME = 'UpdatedAt'
);

SET @sql_add_updated_at = IF(
  @has_updated_at = 0,
  'ALTER TABLE `payment` ADD COLUMN `UpdatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp() AFTER `CreatedAt`',
  'SELECT 1'
);
PREPARE stmt FROM @sql_add_updated_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Tạo bảng paymenttransaction (1 Payment - N PaymentTransaction)
CREATE TABLE IF NOT EXISTS `paymenttransaction` (
  `PaymentTransactionID` bigint(20) NOT NULL AUTO_INCREMENT,
  `PaymentID` bigint(20) NOT NULL,
  `InvoiceID` bigint(20) NOT NULL,
  `Provider` varchar(30) NOT NULL DEFAULT 'VNPAY',
  `VnpTxnRef` varchar(100) NOT NULL,
  `Amount` decimal(18,2) NOT NULL,
  `AmountVnp` bigint(20) NOT NULL COMMENT 'Số tiền nguyên đơn vị VND * 100 gửi sang VNPay',
  `Status` varchar(30) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | SUCCESS | FAILED | CANCELLED | DUPLICATE_CONFLICT',
  `VnpTransactionNo` varchar(100) DEFAULT NULL,
  `VnpBankCode` varchar(50) DEFAULT NULL,
  `VnpBankTranNo` varchar(100) DEFAULT NULL,
  `VnpCardType` varchar(50) DEFAULT NULL,
  `VnpResponseCode` varchar(20) DEFAULT NULL,
  `VnpTransactionStatus` varchar(20) DEFAULT NULL,
  `VnpPayDate` varchar(20) DEFAULT NULL,
  `VnpOrderInfo` varchar(255) DEFAULT NULL,
  `IpAddress` varchar(64) DEFAULT NULL,
  `NeedReconcile` tinyint(1) NOT NULL DEFAULT 0,
  `ReconcileNote` varchar(500) DEFAULT NULL,
  `RawIpnPayload` text DEFAULT NULL,
  `IpnReceivedAt` datetime DEFAULT NULL,
  `ProcessedAt` datetime DEFAULT NULL,
  `LastQueryAt` datetime DEFAULT NULL,
  `CreatedAt` datetime NOT NULL DEFAULT current_timestamp(),
  `UpdatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`PaymentTransactionID`),
  UNIQUE KEY `UQ_PaymentTx_VnpTxnRef` (`VnpTxnRef`),
  KEY `IDX_PaymentTx_PaymentID` (`PaymentID`),
  KEY `IDX_PaymentTx_InvoiceID` (`InvoiceID`),
  KEY `IDX_PaymentTx_Status_CreatedAt` (`Status`, `CreatedAt`),
  CONSTRAINT `FK_PaymentTx_Payment` FOREIGN KEY (`PaymentID`) REFERENCES `payment` (`PaymentID`),
  CONSTRAINT `FK_PaymentTx_Invoice` FOREIGN KEY (`InvoiceID`) REFERENCES `invoice` (`InvoiceID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

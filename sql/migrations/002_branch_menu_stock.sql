-- Migration 002: Quản lý số lượng tồn kho món ăn theo chi nhánh & ngưỡng cảnh báo sắp hết
-- An toàn cho dữ liệu hiện có (StockQuantity = NULL nghĩa là không giới hạn tồn kho).

SET @db_name = DATABASE();

SET @has_stock_qty = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'branchmenuoverride'
    AND COLUMN_NAME = 'StockQuantity'
);

SET @sql_add_stock = IF(
  @has_stock_qty = 0,
  'ALTER TABLE `branchmenuoverride` ADD COLUMN `StockQuantity` decimal(10,3) DEFAULT NULL COMMENT ''NULL: không giới hạn; >=0: số lượng còn tại chi nhánh'' AFTER `IsAvailable`',
  'SELECT 1'
);
PREPARE stmt1 FROM @sql_add_stock;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

SET @has_low_stock = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'branchmenuoverride'
    AND COLUMN_NAME = 'LowStockThreshold'
);

SET @sql_add_low = IF(
  @has_low_stock = 0,
  'ALTER TABLE `branchmenuoverride` ADD COLUMN `LowStockThreshold` decimal(10,3) NOT NULL DEFAULT 5.000 COMMENT ''Mốc cảnh báo sắp hết hàng'' AFTER `StockQuantity`',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql_add_low;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

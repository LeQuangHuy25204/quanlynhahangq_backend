-- Migration 003: Tạo bảng ActivityLog (Audit Log truy vết mọi actor & thao tác quan trọng)
-- Đồng thời bổ sung index trên bảng session phục vụ tự động đóng bàn quá 5 phút chưa mở.
-- Idempotent 100%: an toàn khi chạy lại nhiều lần (--force) trên MySQL 8.0 và MariaDB 10.4+.

CREATE TABLE IF NOT EXISTS `activitylog` (
  `LogID` bigint(20) NOT NULL AUTO_INCREMENT,
  `RestaurantID` bigint(20) NOT NULL DEFAULT 1,
  `BranchID` bigint(20) DEFAULT NULL COMMENT 'NULL nếu thao tác toàn chuỗi hoặc cấp hệ thống',
  `StaffID` bigint(20) DEFAULT NULL COMMENT 'FK tới staff nếu actor là nhân viên/quản lý; NULL nếu Guest/System',
  `ActorType` varchar(30) NOT NULL COMMENT 'RestaurantAdmin | BranchManager | Cashier | Waiter | Guest | System',
  `ActorName` varchar(255) NOT NULL COMMENT 'Tên hiển thị của actor thực hiện thao tác',
  `EntityType` varchar(50) NOT NULL COMMENT 'Tên bảng/đối tượng bị tác động (vd: Session, OrderLine, Payment)',
  `EntityID` bigint(20) DEFAULT NULL COMMENT 'ID bản ghi bị tác động để truy vết vòng đời',
  `Action` varchar(100) NOT NULL COMMENT 'Mã hành động chuẩn hóa (vd: PAYMENT_COMPLETE, SESSION_AUTO_CLOSE_TIMEOUT)',
  `Severity` varchar(20) NOT NULL DEFAULT 'INFO' COMMENT 'Mức độ: INFO | WARNING | CRITICAL',
  `Description` varchar(500) NOT NULL COMMENT 'Mô tả chi tiết bằng tiếng Việt',
  `OldValue` json DEFAULT NULL COMMENT 'Dữ liệu gốc trước khi thay đổi',
  `NewValue` json DEFAULT NULL COMMENT 'Dữ liệu mới sau khi thay đổi',
  `IPAddress` varchar(45) DEFAULT NULL COMMENT 'Địa chỉ IP phát sinh thao tác',
  `Timestamp` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`LogID`),
  KEY `idx_activitylog_restaurant_time` (`RestaurantID`, `Timestamp`),
  KEY `idx_activitylog_branch_time` (`BranchID`, `Timestamp`),
  KEY `idx_activitylog_actor` (`ActorType`, `Timestamp`),
  KEY `idx_activitylog_staff` (`StaffID`, `Timestamp`),
  KEY `idx_activitylog_entity` (`EntityType`, `EntityID`),
  KEY `idx_activitylog_action_severity` (`Action`, `Severity`),
  CONSTRAINT `FK_ActivityLog_Restaurant` FOREIGN KEY (`RestaurantID`) REFERENCES `restaurant` (`RestaurantID`) ON DELETE CASCADE,
  CONSTRAINT `FK_ActivityLog_Branch` FOREIGN KEY (`BranchID`) REFERENCES `branch` (`BranchID`) ON DELETE SET NULL,
  CONSTRAINT `FK_ActivityLog_Staff` FOREIGN KEY (`StaffID`) REFERENCES `staff` (`StaffID`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @db_name = DATABASE();

SET @has_session_wait_idx = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db_name
    AND TABLE_NAME = 'session'
    AND INDEX_NAME = 'idx_session_status_created'
);

SET @sql_add_session_idx = IF(
  @has_session_wait_idx = 0,
  'ALTER TABLE `session` ADD INDEX `idx_session_status_created` (`Status`, `CreatedAt`)',
  'SELECT 1'
);
PREPARE stmt_session_idx FROM @sql_add_session_idx;
EXECUTE stmt_session_idx;
DEALLOCATE PREPARE stmt_session_idx;

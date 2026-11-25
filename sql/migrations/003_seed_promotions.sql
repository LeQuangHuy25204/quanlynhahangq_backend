-- Migration 003: Bổ sung bộ khuyến mãi mẫu đa dạng (Toàn hóa đơn, Món cụ thể, Danh mục món)
-- Idempotent 100%: an toàn khi chạy lại nhiều lần và tương thích cả DB local (4 món) lẫn Railway Cloud (31 món).

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, 1, 'Ưu đãi Bò Mỹ Nướng Đá 20%', 'Giảm 20% khi gọi món Bò Tảng Mỹ nướng đá tại Chi nhánh Quận 1', 'MENU_ITEM', 'PERCENT', 20.00, NULL, NULL, NULL, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Ưu đãi Bò Mỹ Nướng Đá 20%');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, 1, 'Combo Nước Ngọt Giải Nhiệt -10k', 'Giảm 10.000đ mỗi lon nước ngọt khi gọi từ 2 phần trở lên', 'MENU_ITEM', 'FIXED', 10000.00, NULL, NULL, 2, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Combo Nước Ngọt Giải Nhiệt -10k');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, NULL, 'Ưu đãi Mực Lá & Ba Chỉ Nướng 15%', 'Giảm 15% cho Mực lá khổng lồ và Ba chỉ heo cuộn nấm toàn chuỗi', 'MENU_ITEM', 'PERCENT', 15.00, NULL, NULL, NULL, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Ưu đãi Mực Lá & Ba Chỉ Nướng 15%');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, 1, 'Giảm 15% Toàn Bộ Nước Uống', 'Giảm 15% tất cả món thuộc danh mục Nước uống tại Chi nhánh Quận 1', 'CATEGORY', 'PERCENT', 15.00,
       (SELECT `CategoryID` FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Nước uống' LIMIT 1),
       NULL, NULL, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Giảm 15% Toàn Bộ Nước Uống')
  AND EXISTS (SELECT 1 FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Nước uống');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, NULL, 'Lễ Hội Thịt Nướng Giảm 12%', 'Giảm 12% danh mục Thịt nướng khi gọi từ 2 phần trở lên toàn chuỗi', 'CATEGORY', 'PERCENT', 12.00,
       (SELECT `CategoryID` FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Thịt nướng' LIMIT 1),
       NULL, 2, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Lễ Hội Thịt Nướng Giảm 12%')
  AND EXISTS (SELECT 1 FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Thịt nướng');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, 1, 'Tiệc Hải Sản Giảm 30.000đ/món', 'Giảm 30.000đ mỗi phần Hải sản nướng cho hóa đơn từ 300.000đ', 'CATEGORY', 'FIXED', 30000.00,
       (SELECT `CategoryID` FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Hải sản nướng' LIMIT 1),
       300000.00, NULL, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Tiệc Hải Sản Giảm 30.000đ/món')
  AND EXISTS (SELECT 1 FROM `category` WHERE `RestaurantID` = 1 AND `Name` = 'Hải sản nướng');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, NULL, 'Giảm 50.000đ Hóa Đơn Từ 500k', 'Trừ trực tiếp 50.000đ cho hóa đơn có tạm tính từ 500.000đ toàn chuỗi', 'INVOICE', 'FIXED', 50000.00, NULL, 500000.00, NULL, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Giảm 50.000đ Hóa Đơn Từ 500k');

INSERT INTO `promotion` (`RestaurantID`, `BranchID`, `Name`, `Description`, `ApplyLevel`, `DiscountType`, `DiscountValue`, `TargetCategoryID`, `MinOrderAmount`, `MinItemCount`, `MaxUsage`, `StartDate`, `EndDate`, `IsActive`)
SELECT 1, 1, 'Tiệc Nhóm - Giảm 10% Từ 4 Món', 'Giảm 10% tổng hóa đơn khi bàn gọi từ 4 phần món trở lên tại Q1', 'INVOICE', 'PERCENT', 10.00, NULL, NULL, 4, NULL, '2026-01-01 00:00:00', '2030-12-31 23:59:59', 1
WHERE NOT EXISTS (SELECT 1 FROM `promotion` WHERE `RestaurantID` = 1 AND `Name` = 'Tiệc Nhóm - Giảm 10% Từ 4 Món');

-- Gắn món áp dụng cho các khuyến mãi MENU_ITEM (tự khớp những món có trong DB)
INSERT IGNORE INTO `promotion_menuitem` (`PromotionID`, `MenuItemID`)
SELECT p.`PromotionID`, m.`MenuItemID`
FROM `promotion` p
INNER JOIN `menuitem` m ON m.`RestaurantID` = 1
  AND m.`Name` IN ('Bò Tảng Mỹ nướng đá', 'Dẻ sườn bò Mỹ sốt Galbi', 'Ba chỉ bò Mỹ cuộn nấm kim châm')
WHERE p.`RestaurantID` = 1 AND p.`Name` = 'Ưu đãi Bò Mỹ Nướng Đá 20%';

INSERT IGNORE INTO `promotion_menuitem` (`PromotionID`, `MenuItemID`)
SELECT p.`PromotionID`, m.`MenuItemID`
FROM `promotion` p
INNER JOIN `menuitem` m ON m.`RestaurantID` = 1
  AND m.`Name` IN ('Coca Cola', 'Pepsi Black Chanh Không Calo', 'Sprite Chanh Bạc Hà ướp lạnh')
WHERE p.`RestaurantID` = 1 AND p.`Name` = 'Combo Nước Ngọt Giải Nhiệt -10k';

INSERT IGNORE INTO `promotion_menuitem` (`PromotionID`, `MenuItemID`)
SELECT p.`PromotionID`, m.`MenuItemID`
FROM `promotion` p
INNER JOIN `menuitem` m ON m.`RestaurantID` = 1
  AND m.`Name` IN ('Ba chỉ heo cuộn nấm', 'Mực lá khổng lồ')
WHERE p.`RestaurantID` = 1 AND p.`Name` = 'Ưu đãi Mực Lá & Ba Chỉ Nướng 15%';

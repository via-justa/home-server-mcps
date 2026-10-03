-- Levels by kind: a read is none/read/ask, a write none/ask/write, a locked operation none/ask; read
-- or write comes from the plugin and can no longer be overridden. Nothing that was reachable widens.
--
-- 1. Own levels that don't fit their kind, mapped to what they already did:
--    a read at Ask or Write ran, so it becomes Read; a write at Read was hidden, so it becomes None;
--    a locked operation at Read was closed (None), at Write it asked (Ask).
UPDATE `operations` SET `level_override` = 'read'
  WHERE `classification_source` <> 'override' AND `locked` = 0 AND `classification` = 'read'
    AND `level_override` IN ('ask', 'write');
--> statement-breakpoint
UPDATE `operations` SET `level_override` = 'none'
  WHERE `classification_source` <> 'override' AND `locked` = 0 AND `classification` = 'write'
    AND `level_override` = 'read';
--> statement-breakpoint
UPDATE `operations` SET `level_override` = 'none' WHERE `locked` = 1 AND `level_override` = 'read';
--> statement-breakpoint
UPDATE `operations` SET `level_override` = 'ask' WHERE `locked` = 1 AND `level_override` = 'write';
--> statement-breakpoint
-- 2. Admin classification overrides go back to what the plugin says. Where that flips read and write,
--    the operation gets its own level so it never opens wider than before: None if it was off, else Ask.
UPDATE `operations` SET
  `level_override` = CASE
    WHEN `level_override` = 'none' THEN 'none'
    WHEN `level_override` IS NULL
      AND (SELECT `level` FROM `operation_groups` g WHERE g.`id` = `operations`.`group_id`) = 'none' THEN 'none'
    -- A write (by override) at Read was hidden.
    WHEN `classification` = 'write' AND (`level_override` = 'read' OR (`level_override` IS NULL
      AND (SELECT `level` FROM `operation_groups` g WHERE g.`id` = `operations`.`group_id`) = 'read')) THEN 'none'
    ELSE 'ask'
  END,
  `classification` = `inferred_classification`,
  `classification_source` = 'inferred'
  WHERE `classification_source` = 'override' AND `classification` <> `inferred_classification`;
--> statement-breakpoint
UPDATE `operations` SET `classification_source` = 'inferred' WHERE `classification_source` = 'override';

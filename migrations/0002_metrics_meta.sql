-- Optional per-row JSON metadata. Used for the Alacrity SLA comparison operator
-- ({"operator": ">="}) on *_actual rows; NULL everywhere else.
ALTER TABLE metrics ADD COLUMN meta TEXT;

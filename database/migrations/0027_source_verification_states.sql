ALTER TABLE sources DROP CONSTRAINT sources_verification_status_check;
UPDATE sources SET verification_status='approved' WHERE verification_status IN ('technical','held');
ALTER TABLE sources ADD CONSTRAINT sources_verification_status_check
 CHECK (verification_status IN ('pending','approved','failed'));

-- Jobs booked before job lines existed get their booked lines, by the same rules as new
-- bookings (charges.service.ts addBookedLines), from each service's current price.
INSERT INTO "job_items" ("tenant_id", "job_id", "description", "quantity", "unit_price_cents", "status")
SELECT j."tenant_id", j."id",
  CASE s."price_type"
    WHEN 'diagnostic' THEN s."name" || ' (diagnostic fee)'
    WHEN 'free' THEN s."name" || ' (free)'
    ELSE s."name"
  END,
  1,
  CASE s."price_type" WHEN 'free' THEN 0 ELSE s."price_cents" END,
  'approved'
FROM "jobs" j
JOIN "services" s ON s."tenant_id" = j."tenant_id" AND s."id" = j."service_id"
WHERE NOT EXISTS (SELECT 1 FROM "job_items" i WHERE i."tenant_id" = j."tenant_id" AND i."job_id" = j."id");
--> statement-breakpoint
INSERT INTO "job_items" ("tenant_id", "job_id", "description", "quantity", "unit_price_cents", "status")
SELECT j."tenant_id", j."id", 'Priority service', 1, j."priority_fee_cents", 'approved'
FROM "jobs" j
WHERE j."priority_fee_cents" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "job_items" i
    WHERE i."tenant_id" = j."tenant_id" AND i."job_id" = j."id" AND i."description" = 'Priority service'
  );

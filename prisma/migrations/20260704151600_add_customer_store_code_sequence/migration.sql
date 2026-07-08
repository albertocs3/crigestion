CREATE SEQUENCE "customer_store_code_seq"
    AS BIGINT
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE UNIQUE INDEX "customer_stores_one_primary_per_customer_idx"
ON "customer_stores"("customerId")
WHERE "isPrimary" = true;

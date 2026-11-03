-- DES-APPS-001 shared fixture: the MySQL 8 source K1 describes and reads (reads only in v1). Applied
SET SESSION cte_max_recursion_depth = 10000;
-- as root to a FRESH database (tests create one per run; the name replaces {{db}}).
CREATE TABLE {{db}}.refunds (id INT PRIMARY KEY, region VARCHAR(16) NOT NULL, status ENUM('pending', 'approved', 'rejected') NOT NULL, amount DECIMAL(10, 2) NOT NULL, created_at DATETIME NOT NULL);
INSERT INTO {{db}}.refunds VALUES (1, 'EMEA', 'pending', 10.50, '2026-10-01 09:00:00'), (2, 'AMER', 'approved', 99.99, '2026-10-02 10:00:00'), (3, 'EMEA', 'rejected', 5.00, '2026-10-03 11:00:00');
CREATE TABLE {{db}}.ledger (id INT PRIMARY KEY, refund_id INT, CONSTRAINT ledger_refund FOREIGN KEY (refund_id) REFERENCES {{db}}.refunds(id));
CREATE VIEW {{db}}.pending AS SELECT * FROM {{db}}.refunds WHERE status = 'pending';
CREATE TABLE {{db}}.big (n INT PRIMARY KEY);
INSERT INTO {{db}}.big WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 4000) SELECT n FROM g;

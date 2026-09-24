#!/bin/bash
# Runs automatically on first init of a fresh db volume (official Postgres image
# convention: every *.sh/*.sql under /docker-entrypoint-initdb.d runs once, only
# when the data directory is empty). For an already-initialized volume, apply it
# by hand: docker exec -i <db-container> bash < ops/postgres-init/agent-db.sh
# (it's idempotent — safe to re-run).
set -euo pipefail

# psql's :'var'/:"var" substitution (not bash string interpolation) properly
# quotes these as a SQL literal / identifier, so embedded quotes in a
# hand-edited password or name can't break or change the statement. Built as
# conditional `SELECT ... \gexec` rather than a DO $$ ... $$ block, since psql
# doesn't perform :'var' substitution inside dollar-quoted text.
psql -v ON_ERROR_STOP=1 \
	-v agent_db_user="$AGENT_DB_USER" \
	-v agent_db_password="$AGENT_DB_PASSWORD" \
	-v agent_db_name="$AGENT_DB_NAME" \
	-v twenty_db="$POSTGRES_DB" \
	-v twenty_db_user="$POSTGRES_USER" \
	--username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
	SELECT 'CREATE ROLE ' || quote_ident(:'agent_db_user') || ' LOGIN PASSWORD ' || quote_literal(:'agent_db_password')
	WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'agent_db_user')\gexec

	-- Twenty's own database implicitly grants CONNECT to PUBLIC (Postgres default);
	-- revoke that and re-grant only to Twenty's own role, so the new agent role has
	-- zero access to it, not just zero explicit grants.
	REVOKE CONNECT ON DATABASE :"twenty_db" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"twenty_db" TO :"twenty_db_user";

	SELECT 'CREATE DATABASE ' || quote_ident(:'agent_db_name') || ' OWNER ' || quote_ident(:'agent_db_user')
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'agent_db_name')\gexec
EOSQL

ifeq ($(OS),Windows_NT)
    PYTHON := $(shell py -c "import sys; print(sys.executable)" 2>nul || where python 2>nul || where python3 2>nul)
    COPY_CMD := copy
	VENV_PY := .venv/Scripts/python.exe
else
    PYTHON := $(shell command -v python3 || command -v python)
    COPY_CMD := cp
	VENV_PY := .venv/bin/python
endif

# compose v2 plugin if present, else standalone docker-compose binary
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo docker compose || echo docker-compose)

deploy_mysqldb:
	$(COMPOSE) down
	$(COMPOSE) build --no-cache && $(COMPOSE) up -d

deploy_phpmyadmin:
	make deploy_mysqldb
	$(COMPOSE) -f docker-compose.phpmyadmin.yml down
	$(COMPOSE) -f docker-compose.phpmyadmin.yml up -d

deploy_mongodb:
	$(COMPOSE) -f docker-compose.mongodb.yml down
	$(COMPOSE) -f docker-compose.mongodb.yml build --no-cache
	$(COMPOSE) -f docker-compose.mongodb.yml up -d

deploy_mongo_express:
	make deploy_mongodb
	$(COMPOSE) -f docker-compose.mongoexpress.yml down
	$(COMPOSE) -f docker-compose.mongoexpress.yml build --no-cache
	$(COMPOSE) -f docker-compose.mongoexpress.yml up -d

deploy_postgresdb:
	$(COMPOSE) -f docker-compose.postgredb.yml down
	$(COMPOSE) -f docker-compose.postgredb.yml build --no-cache
	$(COMPOSE) -f docker-compose.postgredb.yml up -d

deploy_mssqldb:
	$(COMPOSE) -f docker-compose.mssqldb.yml down
	$(COMPOSE) -f docker-compose.mssqldb.yml up -d

deploy_redisdb:
	$(COMPOSE) -f docker-compose.redisdb.yml down
	$(COMPOSE) -f docker-compose.redisdb.yml up -d

deploy_rabbitmq:
	$(COMPOSE) -f docker-compose.rabbitmq.yml down
	$(COMPOSE) -f docker-compose.rabbitmq.yml up -d
	
deploy_tomcat:
	$(COMPOSE) -f docker-compose.tomcat.yml down
	$(COMPOSE) -f docker-compose.tomcat.yml up -d

deploy_minio:
	$(COMPOSE) -f docker-compose.minio.yml down
	$(COMPOSE) -f docker-compose.minio.yml up -d

deploy_telegram_server:
	$(COMPOSE) -f docker-compose.telegram.yml down
	$(COMPOSE) -f docker-compose.telegram.yml up -d

deploy_postgres_admin:
	$(COMPOSE) -f docker-compose.pgadmin.yml down
	$(COMPOSE) -f docker-compose.pgadmin.yml build --no-cache
	$(COMPOSE) -f docker-compose.pgadmin.yml up -d

deploy_metabase:
	$(COMPOSE) -f docker-compose.metabase.yml down
	$(COMPOSE) -f docker-compose.metabase.yml build --no-cache
	$(COMPOSE) -f docker-compose.metabase.yml up -d

deploy_dbviewer:
	$(COMPOSE) -f docker-compose.dbviewer.yml down
	$(COMPOSE) -f docker-compose.dbviewer.yml build --no-cache
	$(COMPOSE) -f docker-compose.dbviewer.yml up -d

deploy_gitlab_runner:
	$(COMPOSE) -f agent/docker-compose.gitlab-runner.yml down
	$(COMPOSE) -f agent/docker-compose.gitlab-runner.yml build --no-cache
	$(COMPOSE) -f agent/docker-compose.gitlab-runner.yml up -d

# one-time: make register_gitlab_runner RUNNER_TOKEN=glrt-xxxx [GITLAB_URL=https://gitlab.com]
register_gitlab_runner:
	@test -n "$$RUNNER_TOKEN" || { echo "ERROR: RUNNER_TOKEN missing (get it: GitLab > Settings > CI/CD > Runners > New project runner)"; echo 'usage: make register_gitlab_runner RUNNER_TOKEN=glrt-xxxx [GITLAB_URL=https://gitlab.com]'; exit 1; }
	docker exec gitlab-runner gitlab-runner register --non-interactive \
		--url $${GITLAB_URL:-https://gitlab.com} \
		--token $${RUNNER_TOKEN} --executor docker \
		--docker-image alpine:latest --description "local-runner"

run_backup_telegram:
	$(VENV_PY) backup_tele.py

run_backup_discord:
	$(VENV_PY) backup_discord.py

run_remove_file:
	$(VENV_PY) remove_file.py

installPythonRequirement:
	$(PYTHON) -m venv .venv
	$(VENV_PY) -m pip install --upgrade pip
	$(VENV_PY) -m pip install -r requirements.txt
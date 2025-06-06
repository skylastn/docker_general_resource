ifeq ($(OS),Windows_NT)
    PYTHON := $(shell py -c "import sys; print(sys.executable)" 2>nul || where python 2>nul || where python3 2>nul)
    COPY_CMD := copy
else
    PYTHON := $(shell command -v python3 || command -v python)
    COPY_CMD := cp
endif

deploy_mysqldb:
	docker compose down
	docker compose build --no-cache && docker compose up -d

deploy_phpmyadmin:
	make deploy_mysqldb
	docker compose -f docker-compose.phpmyadmin.yml down
	docker compose -f docker-compose.phpmyadmin.yml up -d

deploy_mongodb:
	docker compose -f docker-compose.mongodb.yml down
	docker compose -f docker-compose.mongodb.yml build --no-cache
	docker compose -f docker-compose.mongodb.yml up -d

deploy_postgresdb:
	docker compose -f docker-compose.postgredb.yml down
	docker compose -f docker-compose.postgredb.yml build --no-cache
	docker compose -f docker-compose.postgredb.yml up -d

deploy_mssqldb:
	docker compose -f docker-compose.mssqldb.yml down
	docker compose -f docker-compose.mssqldb.yml up -d

deploy_redisdb:
	docker compose -f docker-compose.redisdb.yml down
	docker compose -f docker-compose.redisdb.yml up -d

deploy_rabbitmq:
	docker compose -f docker-compose.rabbitmq.yml down
	docker compose -f docker-compose.rabbitmq.yml up -d
	
deploy_tomcat:
	docker compose -f docker-compose.tomcat.yml down
	docker compose -f docker-compose.tomcat.yml up -d

deploy_minio:
	docker compose -f docker-compose.minio.yml down
	docker compose -f docker-compose.minio.yml up -d

deploy_telegram_server:
	docker compose -f docker-compose.telegram.yml down
	docker compose -f docker-compose.telegram.yml up -d

deploy_postgres_admin:
	docker-compose -f docker-compose.pgadmin.yml down
	docker-compose -f docker-compose.pgadmin.yml build --no-cache
	docker-compose -f docker-compose.pgadmin.yml up -d

deploy_metabase:
	docker-compose -f docker-compose.metabase.yml down
	docker-compose -f docker-compose.metabase.yml build --no-cache
	docker-compose -f docker-compose.metabase.yml up -d

run_backup_telegram:
	${PYTHON} backup_tele.py

run_backup_discord:
	${PYTHON} backup_discord.py

run_remove_file:
	${PYTHON} remove_file.py
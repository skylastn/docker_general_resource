PYTHON := $(shell command -v python3 || command -v python)

deploy:
	make deploy_database
	make deploy_tomcat

deploy_database:
	make deploy_phpmyadmin
	make deploy_mongodb
	make deploy_mssqldb
	make deploy_redisdb

deploy_mysqldb:
	docker-compose down
	docker-compose --env-file .env up -d

deploy_phpmyadmin:
	make deploy_mysqldb
	docker-compose -f docker-compose.phpmyadmin.yml down
	docker-compose -f docker-compose.phpmyadmin.yml --env-file .env up -d
	

deploy_tomcat:
	docker-compose -f docker-compose.tomcat.yml down
	docker-compose -f docker-compose.tomcat.yml up -d

deploy_mongodb:
	docker-compose -f docker-compose.mongodb.yml down
	docker-compose -f docker-compose.mongodb.yml up -d

deploy_mssqldb:
	docker-compose -f docker-compose.mssqldb.yml down
	docker-compose -f docker-compose.mssqldb.yml up -d

deploy_redisdb:
	docker-compose -f docker-compose.redisdb.yml down
	docker-compose -f docker-compose.redisdb.yml up -d

run_backup_telegram:
	${PYTHON} backup_tele.py

run_backup_discord:
	${PYTHON} backup_discord.py

run_remove_file:
	${PYTHON} remove_file.py
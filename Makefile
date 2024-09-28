deploy:
	make deploy_database
	make deploy_tomcat

deploy_database:
	docker-compose down
	docker-compose up -d

deploy_tomcat:
	docker-compose -f docker-compose.tomcat.yml down
	docker-compose -f docker-compose.tomcat.yml up -d
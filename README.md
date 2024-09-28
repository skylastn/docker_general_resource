Docker Setup for MySQL and phpMyAdmin
This repository contains a Docker Compose setup for running MySQL and phpMyAdmin using Docker. Environment variables for the setup are stored in a .env file.

Prerequisites
Docker installed on your system.
Docker Compose installed.
Project Structure
bash
Copy code
.
├── .env                  # Environment variables
├── docker-compose.yml     # Docker Compose configuration
└── README.md              # This file
Setting up the Environment Variables
In the root of the project, create a .env file (if it doesn't already exist) with the following contents:

makefile
Copy code
MYSQL_ROOT_PASSWORD=yourRootPassword
MYSQL_DATABASE=myDatabase
MYSQL_USER=myUser
MYSQL_PASSWORD=myPassword
Explanation of Environment Variables
MYSQL_ROOT_PASSWORD: The root password for MySQL.
MYSQL_DATABASE: The name of the database to be created.
MYSQL_USER: The MySQL user with access to the database.
MYSQL_PASSWORD: The password for the MySQL user.
You can customize these values according to your requirements.

Docker Compose Setup
The docker-compose.yml defines two services:

MySQL: The MySQL database server.
phpMyAdmin: A web interface for managing the MySQL database.
docker-compose.yml
yaml
Copy code
version: '3.1'

services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql

  phpmyadmin:
    image: phpmyadmin/phpmyadmin
    environment:
      PMA_HOST: db
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    ports:
      - "8080:80"
    volumes:
      - ./php.ini:/usr/local/etc/php/conf.d/php.ini

volumes:
  mysql_data:
Service Ports:
MySQL: Accessible on localhost:3306.
phpMyAdmin: Accessible on localhost:8080.
Running the Containers
To start the MySQL and phpMyAdmin services, run the following command:

bash
Copy code
docker-compose up -d
This will build and run the services in detached mode (-d).

Accessing phpMyAdmin
Once the containers are running, you can access phpMyAdmin via:

arduino
Copy code
http://localhost:8080
Server: db
Username: MYSQL_USER (from .env)
Password: MYSQL_PASSWORD (from .env)
Accessing MySQL via TablePlus
To access MySQL from TablePlus, use the following details:

Host: localhost
Port: 3306
User: MYSQL_USER (from .env)
Password: MYSQL_PASSWORD (from .env)
Stopping and Restarting Services
To stop the services, run:

bash
Copy code
docker-compose down
To start the services again:

bash
Copy code
docker-compose up -d
Persisting Data
The MySQL data is persisted in a Docker volume named mysql_data. This ensures that the database data remains intact even if the container is stopped or removed.

Customizing PHP Configuration
If you need to customize PHP settings for phpMyAdmin, you can modify the php.ini file and mount it as a volume in the phpMyAdmin container:

yaml
Copy code
volumes:
  - ./php.ini:/usr/local/etc/php/conf.d/php.ini
Troubleshooting
Database connection errors: Make sure the .env file is correctly set up and that Docker Compose is able to read the environment variables.
Port conflicts: If the ports 3306 (for MySQL) or 8080 (for phpMyAdmin) are already in use, change them in the docker-compose.yml file.
License
This project is licensed under the MIT License.

Summary
This README.md provides an overview of how to use the Docker Compose setup to run MySQL and phpMyAdmin, including configuration via a .env file, starting the containers, and accessing the services through both phpMyAdmin and TablePlus.

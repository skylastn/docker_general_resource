# 🚀 Project Deployment Automation

![Docker](https://img.shields.io/badge/Docker-✓-blue?logo=docker)
![Makefile](https://img.shields.io/badge/Makefile-✓-green)

This repository provides an automated deployment system for various services using Docker Compose and a Makefile.

---

## 📋 Table of Contents
- [Prerequisites](#-prerequisites)
- [Command Structure](#-command-structure)
- [Usage](#-usage)
- [Project Structure](#-project-structure)
- [Important Notes](#-important-notes)

---

## 🛠️ Prerequisites

- **Docker** and **Docker Compose** installed
- **Python 3.x** (for backup scripts)
- Terminal/Command Prompt

---

## 🎯 Command Structure

### 🔄 Core Deployment
| Command             | Description                          |
|---------------------|--------------------------------------|
| `deployAll`         | Deploy all databases + Tomcat       |
| `deploy_database`   | Deploy all database services        |

### 🗃️ Database Services
| Command                   | Service               | Config File                     |
|---------------------------|-----------------------|---------------------------------|
| `deploy_mysqldb`          | MySQL                 | `docker-compose.yml`           |
| `deploy_phpmyadmin`       | phpMyAdmin            | `docker-compose.phpmyadmin.yml`|
| `deploy_mongodb`          | MongoDB               | `docker-compose.mongodb.yml`   |
| `deploy_postgresdb`       | PostgreSQL            | `docker-compose.postgredb.yml` |
| `deploy_mssqldb`          | MS SQL Server         | `docker-compose.mssqldb.yml`   |
| `deploy_redisdb`          | Redis                 | `docker-compose.redisdb.yml`   |

### 🌐 Servers & Tools
| Command                   | Service               | Config File                     |
|---------------------------|-----------------------|---------------------------------|
| `deploy_tomcat`           | Apache Tomcat         | `docker-compose.tomcat.yml`    |
| `deploy_rabbitmq`         | RabbitMQ              | `docker-compose.rabbitmq.yml`  |
| `deploy_minio`            | MinIO Storage         | `docker-compose.minio.yml`     |
| `deploy_metabase`         | Metabase Analytics    | `docker-compose.metabase.yml`  |

### ⚙️ Utilities
| Command                   | Description            |
|---------------------------|------------------------|
| `run_backup_telegram`     | Run Telegram backup    |
| `run_backup_discord`      | Run Discord backup     |
| `run_remove_file`         | Clean temporary files  |

---

## 🖥️ Usage

### Example Commands
```bash
# Deploy MongoDB + Redis
make deploy_mongodb deploy_redisdb

# Run Telegram backup
make run_backup_telegram

# Deploy all services
make deployAll

Typical Workflow
- Clone the repository.

- Adjust configurations in docker-compose.*.yml files.

Run deployment commands:

make deploy_[service_name]

📂 Project Structure

.
├── docker-compose.yml                # Main MySQL config
├── docker-compose.*.yml              # Service-specific configs
├── Makefile                          # Automation file
├── backup_tele.py                    # Telegram backup script
├── backup_discord.py                 # Discord backup script
└── remove_file.py                    # File cleanup script

⚠️ Important Notes
1. OS Compatibility:

- Windows: Uses py or python.

- Unix-based systems: Uses python3.

2. Dependencies:

- Ensure ports do not conflict in docker-compose files.

- Some services (e.g., MS SQL Server) may require specific hardware resources.

3. Docker Best Practices:

- Rebuild images with --no-cache for updates (e.g., docker compose build --no-cache).

- Always run docker compose down before redeploying a service.
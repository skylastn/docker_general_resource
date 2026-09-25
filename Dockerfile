FROM mysql:8.4

# Config in one layer (COPY --chmod replaces a separate chmod RUN layer)
COPY --chmod=0644 my.cnf /etc/mysql/conf.d/my.cnf

# Start MySQL
CMD ["mysqld"]

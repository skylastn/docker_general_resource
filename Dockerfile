FROM mysql:8.4

# Copy your custom configuration file
COPY my.cnf /etc/mysql/conf.d/my.cnf

# Set the correct permissions for my.cnf
RUN chmod 644 /etc/mysql/conf.d/my.cnf

# Start MySQL
CMD ["mysqld"]

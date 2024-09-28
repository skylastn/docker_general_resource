import os
import requests
from dotenv import load_dotenv
from tqdm import tqdm

# Load environment variables
load_dotenv()

# Configuration
WEBHOOK_URL = os.getenv('DISCORD_WEBHOOK_URL')  # Your Discord webhook URL
FOLDER_TO_BACKUP = os.getenv('PATH_FOLDER')  # Path to the folder to back up
INCLUDE_SUBFOLDER = os.getenv('INCLUDE_SUBFOLDER')  # To determine whether to include subfolders

# Function to send files to Discord via webhook
def send_files_to_discord(folder_path):
    files_to_send = []

    if INCLUDE_SUBFOLDER == "1":
        files_to_send = [os.path.join(folder_path, f) for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
    else:
        for root, dirs, files in os.walk(folder_path):
            for filename in files:
                files_to_send.append(os.path.join(root, filename))

    for file_path in tqdm(files_to_send, desc="Sending files to Discord", unit="file"):
        with open(file_path, 'rb') as f:
            response = requests.post(WEBHOOK_URL, files={'file': (os.path.basename(file_path), f)})
            if response.status_code == 204:
                print(f"File {file_path} successfully sent to the Discord channel.")
            else:
                print(f"Failed to send {file_path}. Status code: {response.status_code}")

# Execution
if __name__ == '__main__':
    print("Starting backup process...")
    
    # Sending files to Discord
    send_files_to_discord(FOLDER_TO_BACKUP)
    
    print("Backup process completed.")

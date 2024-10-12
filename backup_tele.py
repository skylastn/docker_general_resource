import os
from telegram import Bot
from dotenv import load_dotenv
from tqdm import tqdm
import asyncio

# Load environment variables
load_dotenv()

# Configuration
TOKEN = os.getenv('TELEGRAM_TOKEN')  # Your Telegram bot token
CHANNEL_ID = os.getenv('TELEGRAM_CHANNEL_ID')  # Your channel ID
MESSAGE_THREAD_ID = os.getenv('TELEGRAM_MESSAGE_THREAD_ID')  # Your message thread ID
FOLDER_TO_BACKUP = os.getenv('PATH_FOLDER')  # Path to the folder to back up
INCLUDE_SUBFOLDER = os.getenv('INCLUDE_SUBFOLDER')  # To determine whether to include subfolders
API_BASE_URL = os.getenv('API_BASE_URL')  # Your custom API base URL, e.g., 'http://localhost:8081'

# Function to send files to Telegram one by one
async def send_files_to_telegram(folder_path):
    # Set base_url to your local Bot API server
    bot = Bot(token=TOKEN, base_url=f'{API_BASE_URL}/bot')

    try:
        # List to store files to be sent
        files_to_send = []

        # Iterate to get all files from the folder
        if INCLUDE_SUBFOLDER == "1":
            # If INCLUDE_SUBFOLDER is "1", only get files from the main folder
            files_to_send = [os.path.join(folder_path, f) for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
        else:
            # Otherwise, get files from folders and subfolders
            for root, dirs, files in os.walk(folder_path):
                for filename in files:
                    files_to_send.append(os.path.join(root, filename))

        # Send each file
        for file_path in tqdm(files_to_send, desc="Sending files", unit="file"):
            with open(file_path, 'rb') as f:
                await bot.send_document(
                    chat_id=CHANNEL_ID,
                    document=f,
                    message_thread_id=MESSAGE_THREAD_ID  # Using message_thread_id
                )
            print(f"File {file_path} successfully sent to the Telegram channel.")
    except Exception as e:
        print(f"An error occurred while sending files to Telegram: {e}")

# Execution
if __name__ == '__main__':
    print("Starting backup process...")

    # Running coroutine to send files
    asyncio.run(send_files_to_telegram(FOLDER_TO_BACKUP))

    print("Backup process completed.")

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
FOLDER_TO_BACKUP = os.getenv('PATH_FOLDER')  # Path to the folder to back up

# Function to send files to Telegram one by one
async def send_files_to_telegram(folder_path):
    bot = Bot(token=TOKEN)
    try:
        # List all files in the specified folder
        files = [os.path.join(folder_path, f) for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
        
        # Send each file
        for file_path in tqdm(files, desc="Sending files", unit="file"):
            with open(file_path, 'rb') as f:
                await bot.send_document(chat_id=CHANNEL_ID, document=f)
            print(f"File {file_path} successfully sent to the Telegram channel.")
    except Exception as e:
        print(f"An error occurred while sending files to Telegram: {e}")

# Execution
if __name__ == '__main__':
    print("Starting backup process...")
    
    # Running coroutine to send files
    asyncio.run(send_files_to_telegram(FOLDER_TO_BACKUP))
    
    print("Backup process completed.")

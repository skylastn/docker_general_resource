import os
import zipfile
from telegram import Bot
from dotenv import load_dotenv
from tqdm import tqdm
import asyncio

# Memuat variabel lingkungan
load_dotenv()

# Konfigurasi
TOKEN = os.getenv('TELEGRAM_TOKEN')  # Token bot Telegram kamu
CHANNEL_ID = os.getenv('TELEGRAM_CHANNEL_ID')  # ID channel kamu
FOLDER_TO_BACKUP = os.getenv('PATH_FOLDER')  # Path folder yang ingin dibackup
BACKUP_ZIP = 'backup.zip'

# Fungsi untuk membuat zip dari folder dengan indikator progres
def zip_folder(folder_path, zip_path):
    try:
        total_files = sum(len(files) for _, _, files in os.walk(folder_path))
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(folder_path):
                for file in tqdm(files, desc="Mengompres file", unit="file", total=total_files):
                    file_path = os.path.join(root, file)
                    zipf.write(file_path, os.path.relpath(file_path, os.path.dirname(folder_path)))
        
        print("Folder berhasil dikompres menjadi:", zip_path)
    except Exception as e:
        print(f"Terjadi kesalahan saat mengompres folder: {e}")

# Fungsi untuk mengirim file ke Telegram
async def send_file_to_telegram(file_path):
    bot = Bot(token=TOKEN)
    try:
        with open(file_path, 'rb') as f:
            await bot.send_document(chat_id=CHANNEL_ID, document=f)  # Menggunakan await
        print(f"File {file_path} berhasil dikirim ke channel Telegram.")
    except Exception as e:
        print(f"Terjadi kesalahan saat mengirim file ke Telegram: {e}")

# Fungsi untuk menghapus file
def delete_file(file_path):
    try:
        os.remove(file_path)
        print(f"File {file_path} telah dihapus.")
    except OSError as e:
        print(f"Error: {e.strerror}")

# Eksekusi
if __name__ == '__main__':
    print("Memulai proses backup...")
    zip_folder(FOLDER_TO_BACKUP, BACKUP_ZIP)

    # Menjalankan coroutine untuk mengirim file
    asyncio.run(send_file_to_telegram(BACKUP_ZIP))
    
    delete_file(BACKUP_ZIP)  # Menghapus file backup.zip setelah dikirim
    print("Proses backup selesai.")

import os, zipfile
from telegram import Bot
from dotenv import load_dotenv

load_dotenv()

# Konfigurasi
TOKEN = os.getenv('TELEGRAM_TOKEN')  # Ganti dengan token bot Telegram kamu
CHAT_ID = os.getenv('TELEGRAM_CHAT_ID')  # Ganti dengan chat ID kamu
FOLDER_TO_BACKUP = os.getenv('PATH_FOLDER')  # Ganti dengan path folder yang ingin dibackup
BACKUP_ZIP = 'backup.zip'

# Fungsi untuk membuat zip dari folder
def zip_folder(folder_path, zip_path):
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(folder_path):
            for file in files:
                # Membuat path relatif
                file_path = os.path.join(root, file)
                zipf.write(file_path, os.path.relpath(file_path, os.path.dirname(folder_path)))

# Fungsi untuk mengirim file ke Telegram
def send_file_to_telegram(file_path):
    bot = Bot(token=TOKEN)
    with open(file_path, 'rb') as f:
        bot.send_document(chat_id=CHAT_ID, document=f)

# Fungsi untuk menghapus file
def delete_file(file_path):
    try:
        os.remove(file_path)
        print(f"File {file_path} telah dihapus.")
    except OSError as e:
        print(f"Error: {e.strerror}")

# Eksekusi
if __name__ == '__main__':
    zip_folder(FOLDER_TO_BACKUP, BACKUP_ZIP)
    send_file_to_telegram(BACKUP_ZIP)
    delete_file(BACKUP_ZIP)  # Menghapus file backup.zip setelah dikirim
    print("Backup folder telah dikompres, dikirim ke Telegram, dan file zip telah dihapus.")

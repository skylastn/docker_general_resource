import os
import time
from dotenv import load_dotenv

load_dotenv()

# Mengonversi COUNT_DAY_REMOVE menjadi integer
COUNT_DAY_REMOVE = int(os.getenv('COUNT_DAY_REMOVE'))

def delete_old_files(folder_path):
    # Mendapatkan waktu saat ini
    now = time.time()
    
    # Menentukan batas waktu (hari yang ditentukan dalam detik)
    days_in_seconds = COUNT_DAY_REMOVE * 24 * 60 * 60
    deleted_files_count = 0  # Untuk menghitung jumlah file yang dihapus

    # Iterasi melalui semua file dalam folder
    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)

        # Memastikan hanya memproses file
        if os.path.isfile(file_path):
            # Mengambil waktu modifikasi file
            file_age = now - os.path.getmtime(file_path)
            
            # Jika file lebih tua dari jumlah hari yang ditentukan, hapus file tersebut
            if file_age > days_in_seconds:
                os.remove(file_path)
                print(f'Deleted: {file_path}')
                deleted_files_count += 1

    # Memberikan informasi jika tidak ada file yang dihapus
    if deleted_files_count == 0:
        print("Tidak ada file yang dihapus.")

# Ganti 'path/to/your/folder' dengan path folder yang sesuai
folder_path = os.getenv('PATH_REMOVE_FOLDER')
delete_old_files(folder_path)

import os
import time
from dotenv import load_dotenv

load_dotenv()

# Mengonversi COUNT_DAY_REMOVE menjadi integer
COUNT_DAY_REMOVE = int(os.getenv('COUNT_DAY_REMOVE'))
INCLUDE_SUBFOLDER = os.getenv('INCLUDE_SUBFOLDER')

def delete_old_files(folder_path):
    # Mendapatkan waktu saat ini
    now = time.time()
    
    # Menentukan batas waktu (hari yang ditentukan dalam detik)
    days_in_seconds = COUNT_DAY_REMOVE * 24 * 60 * 60
    deleted_files_count = 0  # Untuk menghitung jumlah file yang dihapus

    # Iterasi melalui semua item dalam folder
    for root, dirs, files in os.walk(folder_path):
        if INCLUDE_SUBFOLDER == "1" and root != folder_path:
            # Jika INCLUDE_SUBFOLDER adalah "1", jangan proses subfolder
            continue

        for filename in files:
            file_path = os.path.join(root, filename)

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

#!/usr/bin/env python3
import openpyxl
import msoffcrypto
import json
import sys
from datetime import datetime
import io

password = "AV1312"
file_path = "middlewares/BOOKING DETAILS 2025-26 (3).xlsx"

try:
    with open(file_path, "rb") as file:
        encrypted_file = msoffcrypto.OfficeFile(file)
        encrypted_file.load_key(password=password)
        
        decrypted_file = io.BytesIO()
        encrypted_file.decrypt(decrypted_file)
        
        workbook = openpyxl.load_workbook(decrypted_file, data_only=True)
        sheet = workbook["BOOKING LIST"]
        
        column_mapping = {
            0: 'Date',
            1: 'Booking NO.',
            2: 'Name',
            3: 'Mobile No.',
            4: 'Address',
            5: 'Taluka',
            6: 'District',
            7: 'Advance On Booking Receipts',
            9: 'adv match or not',
            10: 'Advance Amt.',
            11: 'Crop',
            12: 'Variety',
            13: 'Media',
            14: 'Expected Nursery',
            15: 'Plant Qty.',
            16: 'Rate',
            17: 'Expected Del. Date',
            18: 'Old Del. Date',
            19: 'Del. Y/N',
            20: 'Actually Del. Date',
            21: 'Invoice amount',
            22: 'Bal. Amt.',
            23: 'Refrence',
            24: 'Order By',
            25: 'Ad. Amt. Mode',
            26: 'Bank',
            27: 'CH No.',
            28: 'Advance Date',
            32: 'ADV Y/N',
            33: 'CC Y/N',
            36: 'Remark'
        }
        
        rows = []
        for i in range(2, sheet.max_row + 1):
            row_data = {}
            
            for j, cell in enumerate(sheet[i]):
                value = cell.value
                if value is not None:
                    if isinstance(value, datetime):
                        value = value.strftime("%m/%d/%y")
                    elif isinstance(value, (int, float)):
                        value = value
                    else:
                        value = str(value)
                    
                    key = column_mapping.get(j, None)
                    if key:
                        row_data[key] = value
            
            if not any(row_data.values()):
                break
            
            rows.append(row_data)
        
        print(json.dumps(rows, indent=2))
        
except Exception as e:
    print(f"Error reading file: {e}", file=sys.stderr)
    sys.exit(1)






# Location Data Update Scripts

This directory contains scripts to update the database with location data (states, districts, talukas, and villages) from JSON files.

## Scripts Overview

### 1. `update-maharashtra-locations.js`
Simple script to update only Maharashtra location data from `deployment/Maharashtra.json`

### 2. `backup-locations.js`
Creates a backup of current location data before making changes

### 3. `update-all-locations.js` (Recommended)
Comprehensive script that handles:
- Backup creation
- Data processing and validation
- Database update
- Verification
- Detailed reporting

## Prerequisites

1. Ensure MongoDB is running and accessible
2. Set up your environment variables (MONGO_URL)
3. Make sure the `deployment/Maharashtra.json` file exists

## Usage

### Quick Update (Maharashtra only)
```bash
cd FINAL_NURSERY_BE
node scripts/update-maharashtra-locations.js
```

### Create Backup Only
```bash
cd FINAL_NURSERY_BE
node scripts/backup-locations.js
```

### Complete Process (Recommended)
```bash
cd FINAL_NURSERY_BE
node scripts/update-all-locations.js
```

## What Each Script Does

### update-all-locations.js (Complete Process)
1. **Backup**: Creates a timestamped backup of current location data
2. **Read Data**: Reads Maharashtra.json file
3. **Transform**: Converts data to match database schema
4. **Validate**: Checks data integrity
5. **Update**: Updates or creates Maharashtra state in database
6. **Verify**: Confirms the update was successful
7. **Report**: Provides detailed summary

### Data Structure
The scripts expect Maharashtra.json to have this structure:
```json
{
  "districts": [
    {
      "district": "District Name",
      "subDistricts": [
        {
          "subDistrict": "Taluka Name",
          "villages": ["Village1", "Village2", ...]
        }
      ]
    }
  ]
}
```

### Database Schema
The data is stored in the State model with this structure:
```javascript
{
  name: "Maharashtra",
  code: "MH",
  districts: [
    {
      name: "District Name",
      code: "DISTRICT_CODE",
      talukas: [
        {
          name: "Taluka Name",
          code: "TALUKA_CODE",
          villages: [
            {
              name: "Village Name",
              code: "VILLAGE_CODE"
            }
          ]
        }
      ]
    }
  ]
}
```

## Output

The scripts provide detailed console output including:
- Progress indicators
- Data summaries
- Validation results
- Backup locations
- Error messages (if any)

## Backup Files

Backups are stored in `deployment/backups/` with timestamped filenames:
```
locations-backup-2024-01-15T10-30-45-123Z.json
```

## Error Handling

- Database connection errors
- File not found errors
- Data validation errors
- JSON parsing errors
- Database update errors

## Verification

After running the script, you can verify the data by:
1. Checking the console output for success messages
2. Querying the database directly
3. Using the API endpoints to fetch location data

## API Endpoints

After updating, you can use these endpoints to verify the data:
- `GET /state/all` - Get all states
- `GET /state/:stateId` - Get specific state with districts
- `GET /state/:stateId/districts/:districtId/talukas` - Get talukas for a district
- `GET /state/:stateId/districts/:districtId/talukas/:talukaId/villages` - Get villages for a taluka

## Troubleshooting

### Common Issues

1. **MongoDB Connection Error**
   - Check if MongoDB is running
   - Verify MONGO_URL in environment variables

2. **File Not Found**
   - Ensure Maharashtra.json exists in deployment/ directory
   - Check file permissions

3. **Data Validation Failed**
   - Check the JSON structure
   - Ensure all required fields are present

4. **Memory Issues**
   - For large files, consider processing in chunks
   - Monitor system resources

### Recovery

If something goes wrong:
1. Check the backup files in `deployment/backups/`
2. Restore from the most recent backup if needed
3. Check console output for specific error messages

## Performance

- The scripts are optimized for reasonable file sizes
- Large files (>100MB) may require additional optimization
- Consider running during off-peak hours for production databases

## Security

- Scripts only read from specified JSON files
- Backups are created before any modifications
- No sensitive data is logged to console
- Database operations are wrapped in try-catch blocks 
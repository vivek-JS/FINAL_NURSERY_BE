# Quick MongoDB Collection Copy Commands

## Method 1: Direct Copy (One Command)
```bash
# Copy collection from source to destination in one command
mongodump --uri="SOURCE_CONNECTION_STRING" --db="SOURCE_DB" --collection="COLLECTION_NAME" --out="./temp" && \
mongorestore --uri="mongodb://localhost:27017" --db="nursery_production" --collection="COLLECTION_NAME" "./temp/SOURCE_DB/COLLECTION_NAME.bson" && \
rm -rf "./temp"
```

## Method 2: Step by Step
```bash
# Step 1: Dump from source
mongodump --uri="SOURCE_CONNECTION_STRING" --db="SOURCE_DB" --collection="COLLECTION_NAME" --out="./temp_dump"

# Step 2: Restore to destination
mongorestore --uri="mongodb://localhost:27017" --db="nursery_production" --collection="COLLECTION_NAME" "./temp_dump/SOURCE_DB/COLLECTION_NAME.bson"

# Step 3: Clean up
rm -rf "./temp_dump"
```

## Method 3: Using mongoexport/mongoimport (for smaller collections)
```bash
# Export from source
mongoexport --uri="SOURCE_CONNECTION_STRING" --db="SOURCE_DB" --collection="COLLECTION_NAME" --out="collection.json"

# Import to destination
mongoimport --uri="mongodb://localhost:27017" --db="nursery_production" --collection="COLLECTION_NAME" --file="collection.json"

# Clean up
rm "collection.json"
```

## Connection String Examples

### Local MongoDB
```
mongodb://localhost:27017/database_name
```

### MongoDB Atlas
```
mongodb+srv://username:password@cluster.mongodb.net/database_name
```

### MongoDB with Authentication
```
mongodb://username:password@host:port/database_name?authSource=admin
```

## Usage Examples

### Example 1: Copy 'users' collection from Atlas to local
```bash
mongodump --uri="mongodb+srv://user:pass@cluster.mongodb.net/source_db" --db="source_db" --collection="users" --out="./temp" && \
mongorestore --uri="mongodb://localhost:27017" --db="nursery_production" --collection="users" "./temp/source_db/users.bson" && \
rm -rf "./temp"
```

### Example 2: Copy 'orders' collection from another local instance
```bash
mongodump --uri="mongodb://192.168.1.100:27017/old_db" --db="old_db" --collection="orders" --out="./temp" && \
mongorestore --uri="mongodb://localhost:27017" --db="nursery_production" --collection="orders" "./temp/old_db/orders.bson" && \
rm -rf "./temp"
```

## Important Notes

1. **Replace placeholders** with your actual values:
   - `SOURCE_CONNECTION_STRING`: Your source MongoDB connection string
   - `SOURCE_DB`: Source database name
   - `COLLECTION_NAME`: Name of the collection to copy
   - `nursery_production`: Your destination database (change if different)

2. **Authentication**: If your source requires authentication, include username/password in the connection string

3. **Network Access**: Ensure your machine can access the source MongoDB instance

4. **Permissions**: Make sure you have read access to the source collection and write access to the destination database

5. **Large Collections**: For very large collections, consider using `--gzip` flag for compression:
   ```bash
   mongodump --uri="..." --db="..." --collection="..." --gzip --out="./temp"
   mongorestore --uri="..." --db="..." --collection="..." --gzip "./temp/..."
   ``` 
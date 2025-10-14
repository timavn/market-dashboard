# 🔧 FIX: S3 CORS Configuration

## ✅ THE REAL PROBLEM (CONFIRMED)

The error shows:
```
Access to fetch at 'https://market-dashboard-csv-data.s3.us-west-1.amazonaws.com/...'
from origin 'http://localhost:3000' has been blocked by CORS policy
```

**This means:**
- ✅ Backend is working
- ✅ Presigned URL is generated
- ❌ S3 bucket blocks the upload due to missing CORS config

---

## 🎯 SOLUTION: Add CORS to S3 Bucket

### Option 1: AWS Console (Easiest - 2 minutes)

1. **Go to AWS S3 Console:**
   https://s3.console.aws.amazon.com/s3/buckets/market-dashboard-csv-data

2. **Click on your bucket:** `market-dashboard-csv-data`

3. **Go to "Permissions" tab**

4. **Scroll down to "Cross-origin resource sharing (CORS)"**

5. **Click "Edit"**

6. **Paste this CORS configuration:**

```json
[
    {
        "AllowedHeaders": [
            "*"
        ],
        "AllowedMethods": [
            "GET",
            "PUT",
            "POST",
            "DELETE",
            "HEAD"
        ],
        "AllowedOrigins": [
            "http://localhost:3000",
            "http://127.0.0.1:3000"
        ],
        "ExposeHeaders": [
            "ETag"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

7. **Click "Save changes"**

8. **Done!** Try uploading CSV again - should work immediately

---

### Option 2: AWS CLI (If you prefer terminal)

```bash
# Create CORS config file
cat > s3-cors.json << 'EOF'
{
    "CORSRules": [
        {
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
            "AllowedOrigins": [
                "http://localhost:3000",
                "http://127.0.0.1:3000"
            ],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3000
        }
    ]
}
EOF

# Apply CORS to bucket
aws s3api put-bucket-cors \
    --bucket market-dashboard-csv-data \
    --cors-configuration file://s3-cors.json

# Verify it worked
aws s3api get-bucket-cors --bucket market-dashboard-csv-data
```

---

## 🔍 Why This Happened

1. **Presigned URLs work from curl** (no CORS check)
2. **Presigned URLs fail from browser** (CORS check enforced)
3. **S3 bucket created without CORS** (default = block all origins)
4. **Browser blocks the upload** before it reaches S3

---

## 📋 What the CORS Config Does

```json
{
    "AllowedOrigins": ["http://localhost:3000"]
    // ↑ Allows uploads from your React dev server

    "AllowedMethods": ["PUT", "POST", "GET"]
    // ↑ Allows file uploads (PUT) and presigned URL operations

    "AllowedHeaders": ["*"]
    // ↑ Allows Content-Type and other headers

    "ExposeHeaders": ["ETag"]
    // ↑ Allows browser to read ETag (file hash)
}
```

---

## ⚡ After Adding CORS

**No code changes needed!** Just:

1. Add CORS to S3 bucket (above)
2. Refresh browser: `Cmd + Shift + R`
3. Try uploading CSV
4. Should work! 🎉

---

## 🚀 For Production (Later)

When you deploy to production, add your production domain to CORS:

```json
{
    "AllowedOrigins": [
        "http://localhost:3000",
        "https://your-domain.com"
    ]
}
```

---

## ✅ Verification Steps

After adding CORS:

1. **Refresh browser** (Cmd + Shift + R)
2. **Try uploading CSV**
3. **Check console** - should see:
   ```
   🔍 DEBUG: Presigned response status: 200
   🔍 DEBUG: Uploading to S3...
   ✅ Success!
   ```
4. **Check S3 bucket** - file should be there
5. **Check Lambda logs** - should process automatically

---

## 🎯 Summary

**Problem:** S3 CORS not configured
**Solution:** Add CORS config to S3 bucket
**Time:** 2 minutes
**Result:** CSV upload will work

Go to: https://s3.console.aws.amazon.com/s3/buckets/market-dashboard-csv-data
→ Permissions → CORS → Edit → Paste config above → Save

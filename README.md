# Market Dashboard

Financial market dashboard with portfolio analytics and real-time data.

## 🚀 **Today's Progress (October 1, 2025)**

### ✅ **Completed:**
- **Development Environment Setup**: Node.js 18.20.8 installed via nvm
- **Dependencies Installed**: All React dependencies and dev tools configured
- **Development Server**: React app running on localhost:3000
- **Production Build**: Successfully builds optimized production bundle
- **AWS Integration Planning**: Designed automated CSV processing architecture
- **Portfolio Data Structure**: Zeroed out portfolio section for Schwab integration
- **AWS Infrastructure**: DynamoDB tables and S3 bucket created
- **Lambda Function**: CSVPortfolioProcessor created (needs configuration)

### 🎯 **Tomorrow's Tasks:**
- **Lambda Configuration**: Change runtime to Python 3.9, set memory/timeout
- **IAM Permissions**: Add S3 and DynamoDB access to Lambda role
- **Python Code**: Write CSV processing logic for Schwab data
- **S3 Trigger**: Configure automatic processing on CSV upload
- **Testing**: Test the complete pipeline with sample data

## 🏗️ **Architecture Overview**

```
📧 CSV Upload → 📁 S3 → ⚡ Lambda → 🗄️ DynamoDB → 🌐 API Gateway → 📊 Dashboard
```

## 🛠️ **Tech Stack**
- **Frontend**: React 18, Tailwind CSS
- **Backend**: Express.js, AWS Services
- **Database**: DynamoDB
- **Storage**: AWS S3
- **Compute**: AWS Lambda
- **Deployment**: AWS S3 + CloudFront

## 📊 **AWS Services Used**
- S3 (Static hosting + CSV storage)
- DynamoDB (Portfolio data)
- Lambda (CSV processing)
- API Gateway (Data API)
- IAM (Security)

## 🚀 **Quick Start**
```bash
# Install dependencies
npm install

# Start development server
npm start

# Build for production
npm run build

# Start backend server
npm run server
```

## 📁 **Project Structure**
- `src/components/` - React components
- `src/services/` - API services and WebSocket
- `src/hooks/` - Custom React hooks
- `src/constants/` - Configuration files
- `deploy/` - AWS deployment documentation
- `aws/` - AWS infrastructure code
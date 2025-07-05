# Interactive Cost-Optimized Deployment

This is the easiest way to deploy your Nursery Management System to AWS with cost optimization!

## 🚀 Quick Start

Simply run the interactive deployment script:

```bash
./deployment/aws/deploy-interactive.sh
```

The script will:
1. ✅ Ask you for required information (domain, email, budget, etc.)
2. ✅ Check your AWS Free Tier eligibility
3. ✅ Estimate monthly costs
4. ✅ Deploy cost-optimized infrastructure
5. ✅ Build and deploy your application
6. ✅ Run health checks
7. ✅ Provide you with access URLs

## 📋 What You'll Need

### Required Information
- **AWS Region**: Where to deploy (default: us-east-1)
- **Project Name**: Name for your project (default: nursery-backend)
- **Environment**: production/staging/development (default: production)
- **Admin Email**: For notifications and alerts
- **Monthly Budget**: Cost limit (default: $50)

### Optional Information
- **Domain Name**: Your custom domain (optional - can be added later)

## 💰 Cost Optimization Features

This deployment uses several cost optimization strategies:

### AWS Free Tier
- ✅ Lambda: 1M requests, 400K GB-seconds free
- ✅ API Gateway: 1M requests free
- ✅ S3: 5GB storage, 20K requests free
- ✅ CloudFront: 1TB data transfer free
- ✅ CloudWatch: 5GB logs, 10 metrics free

### Serverless Architecture
- ✅ Lambda functions instead of ECS (pay per request)
- ✅ API Gateway instead of ALB (pay per request)
- ✅ S3 + CloudFront for frontend hosting

### Cost Controls
- ✅ Smallest instance sizes (t3.micro)
- ✅ Single instances for databases
- ✅ Reduced log retention (7 days)
- ✅ S3 lifecycle policies for cost optimization
- ✅ Monthly budget alerts

## 📊 Estimated Costs

### With Free Tier (first 12 months)
- **Total**: ~$31/month
- DocumentDB: ~$15/month
- ElastiCache: ~$15/month
- Route53: ~$1/month

### Without Free Tier
- **Total**: ~$51/month
- Lambda: ~$5/month
- API Gateway: ~$3/month
- S3: ~$2/month
- CloudFront: ~$5/month
- DocumentDB: ~$15/month
- ElastiCache: ~$15/month
- Route53: ~$1/month
- CloudWatch: ~$5/month

## 🏗️ What Gets Deployed

### Infrastructure
- ✅ VPC with public/private subnets
- ✅ Security groups for Lambda, DocumentDB, Redis
- ✅ API Gateway for serverless API
- ✅ Lambda function for backend
- ✅ DocumentDB cluster (t3.micro)
- ✅ ElastiCache Redis (t3.micro)
- ✅ S3 buckets for frontend, uploads, backups
- ✅ CloudFront distribution (if domain provided)
- ✅ Route53 records (if domain provided)
- ✅ ACM certificate (if domain provided)
- ✅ CloudWatch monitoring and alerts
- ✅ AWS Budgets for cost control

### Application
- ✅ Backend API deployed to Lambda
- ✅ Frontend deployed to S3 + CloudFront
- ✅ Health checks and monitoring

## 🔧 Management Commands

After deployment, you can:

```bash
# View infrastructure details
cd deployment/aws/terraform/cost-optimized && terraform show

# Update deployment
./deployment/aws/deploy-interactive.sh

# Destroy infrastructure (⚠️ careful!)
cd deployment/aws/terraform/cost-optimized && terraform destroy

# View costs in AWS Console
# Go to AWS Cost Explorer or AWS Budgets
```

## 🚨 Important Notes

1. **AWS Credentials**: Make sure you have AWS CLI configured with appropriate permissions
2. **Domain**: If you provide a domain, make sure it's registered in Route53
3. **Costs**: Monitor your AWS costs regularly using the budget alerts
4. **Free Tier**: Check your Free Tier usage in the AWS Console

## 🆘 Troubleshooting

### Common Issues

**"AWS credentials not configured"**
```bash
aws configure
```

**"Terraform not installed"**
```bash
# macOS
brew install terraform

# Linux
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add -
sudo apt-add-repository "deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs) main"
sudo apt-get update && sudo apt-get install terraform
```

**"Domain not found in Route53"**
- Make sure your domain is registered in Route53
- Or skip domain configuration for now

## 📞 Support

If you encounter any issues:
1. Check the deployment logs
2. Review the Terraform outputs
3. Check AWS CloudWatch logs
4. Verify your AWS credentials and permissions

## 🎯 Next Steps

After successful deployment:
1. Update your domain DNS settings (if custom domain)
2. Configure your frontend to use the API Gateway URL
3. Set up additional monitoring and alerting
4. Review the cost optimization guide
5. Test your application thoroughly

Happy deploying! 🚀 
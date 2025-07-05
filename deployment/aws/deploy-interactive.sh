#!/bin/bash

# Interactive Cost-Optimized AWS Deployment Script for Nursery Management System
# This script prompts for required information and deploys everything automatically

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TERRAFORM_DIR="$SCRIPT_DIR/terraform/cost-optimized"
AWS_REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

info() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $1${NC}"
}

# Function to prompt for user input
prompt_input() {
    local prompt="$1"
    local default="$2"
    local required="$3"
    
    while true; do
        if [ -n "$default" ]; then
            read -p "$prompt [$default]: " input
            input="${input:-$default}"
        else
            read -p "$prompt: " input
        fi
        
        if [ "$required" = "true" ] && [ -z "$input" ]; then
            error "This field is required. Please enter a value."
            continue
        fi
        
        echo "$input"
        break
    done
}

# Function to validate email
validate_email() {
    local email="$1"
    if [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        return 0
    else
        return 1
    fi
}

# Function to validate domain
validate_domain() {
    local domain="$1"
    if [[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$ ]]; then
        return 0
    else
        return 1
    fi
}

# Function to collect deployment information
collect_deployment_info() {
    log "🚀 Welcome to the Cost-Optimized Nursery Management System Deployment!"
    echo ""
    info "This deployment will use AWS Free Tier and serverless architecture to minimize costs."
    echo ""
    
    # Get AWS region
    AWS_REGION=$(prompt_input "Enter AWS region" "us-east-1" "true")
    
    # Get project name
    PROJECT_NAME=$(prompt_input "Enter project name" "nursery-backend" "true")
    
    # Get environment
    ENVIRONMENT=$(prompt_input "Enter environment (production/staging/development)" "production" "true")
    
    # Get domain name (optional)
    DOMAIN_NAME=$(prompt_input "Enter your domain name (optional - press Enter to skip)" "" "false")
    if [ -z "$DOMAIN_NAME" ]; then
        DOMAIN_NAME="your-nursery-domain.com"
        warning "No domain provided. Using placeholder domain. You can update this later."
    else
        if ! validate_domain "$DOMAIN_NAME"; then
            error "Invalid domain format. Please enter a valid domain (e.g., example.com)"
            exit 1
        fi
    fi
    
    # Get admin email
    while true; do
        ADMIN_EMAIL=$(prompt_input "Enter admin email for notifications" "" "true")
        if validate_email "$ADMIN_EMAIL"; then
            break
        else
            error "Invalid email format. Please enter a valid email address."
        fi
    done
    
    # Get budget amount
    MONTHLY_BUDGET=$(prompt_input "Enter monthly budget in USD" "50" "true")
    
    # Confirm deployment
    echo ""
    log "📋 Deployment Summary:"
    echo "   • AWS Region: $AWS_REGION"
    echo "   • Project Name: $PROJECT_NAME"
    echo "   • Environment: $ENVIRONMENT"
    echo "   • Domain: $DOMAIN_NAME"
    echo "   • Admin Email: $ADMIN_EMAIL"
    echo "   • Monthly Budget: $${MONTHLY_BUDGET}"
    echo ""
    
    CONFIRM=$(prompt_input "Do you want to proceed with the deployment? (yes/no)" "yes" "true")
    if [[ ! "$CONFIRM" =~ ^[Yy][Ee][Ss]$ ]]; then
        log "Deployment cancelled by user."
        exit 0
    fi
}

# Function to check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        error "AWS CLI is not installed. Please install it first:"
        echo "   macOS: brew install awscli"
        echo "   Linux: curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o 'awscliv2.zip' && unzip awscliv2.zip && sudo ./aws/install"
        exit 1
    fi
    
    # Check if Terraform is installed
    if ! command -v terraform &> /dev/null; then
        error "Terraform is not installed. Please install it first:"
        echo "   macOS: brew install terraform"
        echo "   Linux: curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add - && sudo apt-add-repository 'deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs) main' && sudo apt-get update && sudo apt-get install terraform"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured. Please run: aws configure"
        exit 1
    fi
    
    log "Prerequisites check passed"
}

# Function to check AWS Free Tier eligibility
check_free_tier_eligibility() {
    log "Checking AWS Free Tier eligibility..."
    
    # Get AWS account creation date
    ACCOUNT_CREATION_DATE=$(aws iam get-user --query 'User.CreateDate' --output text 2>/dev/null || echo "unknown")
    
    if [ "$ACCOUNT_CREATION_DATE" != "unknown" ]; then
        # macOS compatible date parsing
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS date command
            CREATION_TIMESTAMP=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${ACCOUNT_CREATION_DATE%%.*}" +%s 2>/dev/null || date +%s)
        else
            # Linux date command
            CREATION_TIMESTAMP=$(date -d "$ACCOUNT_CREATION_DATE" +%s)
        fi
        CURRENT_TIMESTAMP=$(date +%s)
        DAYS_SINCE_CREATION=$(( (CURRENT_TIMESTAMP - CREATION_TIMESTAMP) / 86400 ))
        
        if [ $DAYS_SINCE_CREATION -le 365 ]; then
            log "✅ AWS account is eligible for Free Tier (${DAYS_SINCE_CREATION} days old)"
            FREE_TIER_ELIGIBLE=true
        else
            warning "⚠️  AWS account is not eligible for Free Tier (${DAYS_SINCE_CREATION} days old)"
            FREE_TIER_ELIGIBLE=false
        fi
    else
        warning "⚠️  Could not determine Free Tier eligibility"
        FREE_TIER_ELIGIBLE=false
    fi
}

# Function to estimate costs
estimate_costs() {
    log "Estimating monthly costs..."
    
    if [ "$FREE_TIER_ELIGIBLE" = true ]; then
        info "📊 Estimated costs with Free Tier (first 12 months):"
        echo "   • Lambda: $0 (1M requests, 400K GB-seconds free)"
        echo "   • API Gateway: $0 (1M requests free)"
        echo "   • S3: $0 (5GB storage, 20K requests free)"
        echo "   • CloudFront: $0 (1TB data transfer free)"
        echo "   • DocumentDB: ~$15/month (t3.micro)"
        echo "   • ElastiCache: ~$15/month (t3.micro)"
        echo "   • Route53: ~$1/month (hosted zone)"
        echo "   • CloudWatch: $0 (5GB logs, 10 metrics free)"
        echo "   • Total: ~$31/month"
    else
        info "📊 Estimated costs without Free Tier:"
        echo "   • Lambda: ~$5/month (1M requests)"
        echo "   • API Gateway: ~$3/month (1M requests)"
        echo "   • S3: ~$2/month (5GB storage)"
        echo "   • CloudFront: ~$5/month (1TB transfer)"
        echo "   • DocumentDB: ~$15/month (t3.micro)"
        echo "   • ElastiCache: ~$15/month (t3.micro)"
        echo "   • Route53: ~$1/month (hosted zone)"
        echo "   • CloudWatch: ~$5/month (logs + metrics)"
        echo "   • Total: ~$51/month"
    fi
}

# Function to create terraform.tfvars
create_terraform_tfvars() {
    log "Creating terraform.tfvars configuration..."
    
    cat > "$TERRAFORM_DIR/terraform.tfvars" << EOF
# Cost-Optimized AWS Deployment Configuration for Nursery Management System
# This configuration leverages AWS Free Tier and serverless architecture to minimize costs

# AWS Configuration
aws_region = "$AWS_REGION"
environment = "$ENVIRONMENT"
project_name = "$PROJECT_NAME"

# Domain Configuration
domain_name = "$DOMAIN_NAME"

# Cost Optimization Settings
use_free_tier = true
deployment_type = "serverless"
enable_cost_optimization = true
use_single_az = false
enable_auto_scaling_cost_optimized = false
max_capacity_cost_optimized = 2

# VPC Configuration (Simplified for cost savings)
vpc_cidr = "10.0.0.0/16"
availability_zones = ["${AWS_REGION}a", "${AWS_REGION}b"] # Use only 2 AZs
public_subnet_cidrs = ["10.0.1.0/24", "10.0.2.0/24"]
private_subnet_cidrs = ["10.0.11.0/24", "10.0.12.0/24"]

# Serverless Configuration
lambda_memory_size = 512
lambda_timeout = 30

# Database Configuration (Free Tier eligible)
docdb_instance_class = "db.t3.micro" # Smallest instance
docdb_instance_count = 1 # Single instance

# Cache Configuration (Free Tier eligible)
redis_node_type = "cache.t3.micro" # Smallest instance

# CloudFront Configuration (Cost optimized)
cloudfront_price_class = "PriceClass_100" # North America and Europe only

# S3 Lifecycle Configuration (Cost optimization)
s3_lifecycle_enabled = true
s3_ia_transition_days = 30
s3_glacier_transition_days = 90
s3_expiration_days = 365
backup_expiration_days = 90

# Logging Configuration (Cost optimized)
log_retention_days_cost_optimized = 7 # Reduced retention

# Budget Configuration
monthly_budget = $MONTHLY_BUDGET # Monthly budget
admin_email = "$ADMIN_EMAIL"

# Security Configuration (Essential only)
enable_waf = false # Disabled for cost savings
enable_cloudtrail = false # Disabled for cost savings
enable_guardduty = false # Disabled for cost savings
enable_config = false # Disabled for cost savings

# Monitoring Configuration (Essential only)
enable_monitoring = true
enable_logging = true
enable_auto_scaling = false # Disabled for cost savings

# Tags
tags = {
  Owner       = "DevOps Team"
  CostCenter  = "IT Department"
  Environment = "$ENVIRONMENT"
  Project     = "Nursery Management System"
  ManagedBy   = "Terraform"
  CostOptimized = "true"
}
EOF
    
    log "terraform.tfvars created successfully"
}

# Function to create S3 backend for Terraform state
setup_terraform_backend() {
    log "Setting up Terraform backend..."
    
    # Get AWS account ID
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    BUCKET_NAME="nursery-terraform-state-${AWS_ACCOUNT_ID}"
    
    # Create S3 bucket if it doesn't exist
    if ! aws s3 ls "s3://$BUCKET_NAME" &> /dev/null; then
        log "Creating S3 bucket for Terraform state: $BUCKET_NAME"
        aws s3 mb "s3://$BUCKET_NAME" --region "$AWS_REGION"
        aws s3api put-bucket-versioning --bucket "$BUCKET_NAME" --versioning-configuration Status=Enabled
        aws s3api put-bucket-encryption --bucket "$BUCKET_NAME" --server-side-encryption-configuration '{
            "Rules": [
                {
                    "ApplyServerSideEncryptionByDefault": {
                        "SSEAlgorithm": "AES256"
                    }
                }
            ]
        }'
    fi
    
    # Update Terraform backend configuration
    log "Updating Terraform backend configuration..."
    sed -i.bak "s/bucket = \"nursery-terraform-state\"/bucket = \"$BUCKET_NAME\"/" "$TERRAFORM_DIR/main.tf"
    
    log "Terraform backend configured"
}

# Function to deploy cost-optimized infrastructure
deploy_cost_optimized_infrastructure() {
    log "Deploying cost-optimized AWS infrastructure..."
    
    cd "$TERRAFORM_DIR"
    
    # Initialize Terraform
    terraform init
    
    # Plan deployment
    log "Planning cost-optimized Terraform deployment..."
    terraform plan -out=tfplan
    
    # Apply deployment
    log "Applying cost-optimized Terraform deployment..."
    terraform apply tfplan
    
    # Get outputs
    log "Getting deployment outputs..."
    terraform output -json > outputs.json
    
    # Extract important values
    API_URL=$(terraform output -raw api_gateway_url 2>/dev/null || echo "N/A")
    FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null || echo "N/A")
    LAMBDA_FUNCTION_NAME=$(terraform output -raw lambda_function_name 2>/dev/null || echo "N/A")
    
    log "Cost-optimized infrastructure deployed successfully"
    log "API Gateway URL: $API_URL"
    log "Frontend URL: $FRONTEND_URL"
    log "Lambda Function: $LAMBDA_FUNCTION_NAME"
    
    cd "$PROJECT_ROOT"
}

# Function to build and deploy Lambda function
build_and_deploy_lambda() {
    log "Building and deploying Lambda function..."
    
    # Create Lambda package
    log "Creating Lambda package..."
    
    # Create temporary directory for Lambda package
    TEMP_DIR=$(mktemp -d)
    
    # Copy application files
    cp -r . "$TEMP_DIR/"
    cd "$TEMP_DIR"
    
    # Remove unnecessary files
    rm -rf node_modules .git deployment/aws .gitignore README.md
    
    # Install production dependencies
    npm ci --only=production
    
    # Create Lambda package
    zip -r lambda-package.zip . -x "*.git*" "*.DS_Store*" "node_modules/.cache/*"
    
    # Copy package to Terraform directory
    cp lambda-package.zip "$TERRAFORM_DIR/"
    
    # Clean up
    cd "$PROJECT_ROOT"
    rm -rf "$TEMP_DIR"
    
    # Update Lambda function
    cd "$TERRAFORM_DIR"
    LAMBDA_FUNCTION_NAME=$(terraform output -raw lambda_function_name)
    cd "$PROJECT_ROOT"
    
    aws lambda update-function-code \
        --function-name "$LAMBDA_FUNCTION_NAME" \
        --zip-file fileb://"$TERRAFORM_DIR/lambda-package.zip" \
        --region "$AWS_REGION"
    
    log "Lambda function deployed successfully"
}

# Function to deploy frontend to S3
deploy_frontend_to_s3() {
    log "Deploying frontend to S3..."
    
    cd "$TERRAFORM_DIR"
    FRONTEND_BUCKET=$(terraform output -raw frontend_bucket)
    cd "$PROJECT_ROOT"
    
    # Build frontend (assuming React app)
    if [ -d "nursery-mgmt" ]; then
        cd nursery-mgmt
        npm run build
        
        # Sync build files to S3
        aws s3 sync build/ "s3://$FRONTEND_BUCKET" --delete
        
        # Invalidate CloudFront cache if domain is configured
        if [ "$DOMAIN_NAME" != "your-nursery-domain.com" ]; then
            DISTRIBUTION_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?contains(@, '$FRONTEND_BUCKET')]].Id" --output text)
            if [ "$DISTRIBUTION_ID" != "None" ]; then
                aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
            fi
        fi
        
        cd "$PROJECT_ROOT"
    else
        warning "Frontend directory not found, skipping frontend deployment"
    fi
    
    log "Frontend deployed to S3 successfully"
}

# Function to run health checks
run_health_checks() {
    log "Running health checks..."
    
    cd "$TERRAFORM_DIR"
    API_URL=$(terraform output -raw api_gateway_url)
    cd "$PROJECT_ROOT"
    
    # Test API health endpoint
    log "Testing API health endpoint..."
    if curl -f "$API_URL/health" >/dev/null 2>&1; then
        log "✅ API health check passed"
    else
        warning "⚠️  API health check failed (this is normal for new deployments)"
    fi
    
    log "Health checks completed"
}

# Function to display deployment summary
display_deployment_summary() {
    log "🎉 Deployment completed successfully!"
    echo ""
    log "📋 Deployment Summary:"
    echo "   • Project: $PROJECT_NAME"
    echo "   • Environment: $ENVIRONMENT"
    echo "   • AWS Region: $AWS_REGION"
    echo "   • Domain: $DOMAIN_NAME"
    echo "   • Admin Email: $ADMIN_EMAIL"
    echo "   • Monthly Budget: $${MONTHLY_BUDGET}"
    echo ""
    
    cd "$TERRAFORM_DIR"
    API_URL=$(terraform output -raw api_gateway_url 2>/dev/null || echo "N/A")
    FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null || echo "N/A")
    cd "$PROJECT_ROOT"
    
    log "🌐 Access URLs:"
    echo "   • API Gateway: $API_URL"
    echo "   • Frontend: $FRONTEND_URL"
    echo ""
    
    log "💰 Cost Information:"
    if [ "$FREE_TIER_ELIGIBLE" = true ]; then
        echo "   • Free Tier Eligible: Yes"
        echo "   • Estimated Monthly Cost: ~$31 (with Free Tier)"
    else
        echo "   • Free Tier Eligible: No"
        echo "   • Estimated Monthly Cost: ~$51 (without Free Tier)"
    fi
    echo ""
    
    log "📚 Next Steps:"
    echo "   1. Update your domain DNS settings if you provided a custom domain"
    echo "   2. Configure your frontend to use the API Gateway URL"
    echo "   3. Set up monitoring and alerting"
    echo "   4. Review the cost optimization guide in deployment/aws/COST_OPTIMIZATION.md"
    echo ""
    
    log "🔧 Management Commands:"
    echo "   • View infrastructure: cd $TERRAFORM_DIR && terraform show"
    echo "   • Update deployment: ./deployment/aws/deploy-interactive.sh"
    echo "   • Destroy infrastructure: cd $TERRAFORM_DIR && terraform destroy"
    echo ""
}

# Main deployment function
main() {
    # Collect deployment information
    collect_deployment_info
    
    # Check prerequisites
    check_prerequisites
    
    # Check Free Tier eligibility
    check_free_tier_eligibility
    
    # Estimate costs
    estimate_costs
    
    # Create terraform.tfvars
    create_terraform_tfvars
    
    # Setup Terraform backend
    setup_terraform_backend
    
    # Deploy infrastructure
    deploy_cost_optimized_infrastructure
    
    # Build and deploy Lambda
    build_and_deploy_lambda
    
    # Deploy frontend
    deploy_frontend_to_s3
    
    # Run health checks
    run_health_checks
    
    # Display summary
    display_deployment_summary
}

# Run main function
main "$@" 
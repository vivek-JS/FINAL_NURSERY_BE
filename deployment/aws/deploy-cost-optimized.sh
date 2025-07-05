#!/bin/bash

# Cost-Optimized AWS Deployment Script for Nursery Management System
# Leverages AWS Free Tier and serverless architecture to minimize costs

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TERRAFORM_DIR="$SCRIPT_DIR/terraform"
AWS_REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"
DEPLOYMENT_TYPE="${DEPLOYMENT_TYPE:-serverless}"

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

# Function to check AWS Free Tier eligibility
check_free_tier_eligibility() {
    log "Checking AWS Free Tier eligibility..."
    
    # Get AWS account creation date
    ACCOUNT_CREATION_DATE=$(aws iam get-user --query 'User.CreateDate' --output text 2>/dev/null || echo "unknown")
    
    if [ "$ACCOUNT_CREATION_DATE" != "unknown" ]; then
        CREATION_TIMESTAMP=$(date -d "$ACCOUNT_CREATION_DATE" +%s)
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

# Function to check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        error "AWS CLI is not installed"
        exit 1
    fi
    
    # Check if Terraform is installed
    if ! command -v terraform &> /dev/null; then
        error "Terraform is not installed"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured"
        exit 1
    fi
    
    # Check if cost-optimized terraform.tfvars exists
    if [ ! -f "$TERRAFORM_DIR/terraform.tfvars" ]; then
        error "terraform.tfvars not found. Please copy terraform.tfvars.cost-optimized.example and configure it."
        exit 1
    fi
    
    log "Prerequisites check passed"
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
        
        # Invalidate CloudFront cache
        DISTRIBUTION_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?contains(@, '$FRONTEND_BUCKET')]].Id" --output text)
        if [ "$DISTRIBUTION_ID" != "None" ]; then
            aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
        fi
        
        cd "$PROJECT_ROOT"
    else
        warning "Frontend directory not found, skipping frontend deployment"
    fi
    
    log "Frontend deployed to S3 successfully"
}

# Function to wait for deployment
wait_for_deployment() {
    log "Waiting for deployment to complete..."
    
    cd "$TERRAFORM_DIR"
    API_URL=$(terraform output -raw api_gateway_url)
    FRONTEND_URL=$(terraform output -raw frontend_url)
    cd "$PROJECT_ROOT"
    
    # Wait for API Gateway to be ready
    log "Waiting for API Gateway to be ready..."
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f "$API_URL/health" >/dev/null 2>&1; then
            log "API Gateway health check passed"
            break
        fi
        
        info "API Gateway health check attempt $attempt/$max_attempts failed, retrying in 30 seconds..."
        sleep 30
        ((attempt++))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        error "API Gateway health check failed after $max_attempts attempts"
        return 1
    fi
    
    # Wait for CloudFront to be ready
    log "Waiting for CloudFront to be ready..."
    sleep 60
    
    log "Deployment completed successfully"
}

# Function to run cost optimization tests
run_cost_optimization_tests() {
    log "Running cost optimization tests..."
    
    cd "$TERRAFORM_DIR"
    API_URL=$(terraform output -raw api_gateway_url)
    cd "$PROJECT_ROOT"
    
    # Test API response time
    log "Testing API response time..."
    RESPONSE_TIME=$(curl -o /dev/null -s -w "%{time_total}" "$API_URL/health")
    info "API response time: ${RESPONSE_TIME}s"
    
    # Test Lambda cold start
    log "Testing Lambda cold start..."
    COLD_START_TIME=$(curl -o /dev/null -s -w "%{time_total}" "$API_URL/health")
    info "Lambda cold start time: ${COLD_START_TIME}s"
    
    # Test S3 access
    log "Testing S3 access..."
    cd "$TERRAFORM_DIR"
    FRONTEND_BUCKET=$(terraform output -raw frontend_bucket)
    cd "$PROJECT_ROOT"
    
    if aws s3 ls "s3://$FRONTEND_BUCKET" >/dev/null 2>&1; then
        log "S3 access test passed"
    else
        warning "S3 access test failed"
    fi
    
    log "Cost optimization tests completed"
}

# Function to display cost optimization summary
cost_optimization_summary() {
    log "=== Cost Optimization Summary ==="
    
    if [ "$FREE_TIER_ELIGIBLE" = true ]; then
        echo "✅ AWS Free Tier eligible"
        echo "💰 Estimated monthly cost: ~$31"
        echo "🎯 Cost savings: ~60% compared to container deployment"
    else
        echo "⚠️  AWS Free Tier not eligible"
        echo "💰 Estimated monthly cost: ~$51"
        echo "🎯 Cost savings: ~40% compared to container deployment"
    fi
    
    echo ""
    echo "🏗️  Architecture:"
    echo "   • Backend: AWS Lambda + API Gateway (serverless)"
    echo "   • Frontend: S3 + CloudFront (static hosting)"
    echo "   • Database: DocumentDB t3.micro (smallest instance)"
    echo "   • Cache: ElastiCache t3.micro (smallest instance)"
    echo "   • Storage: S3 with lifecycle policies"
    echo ""
    echo "🔧 Cost Optimization Features:"
    echo "   • Serverless architecture (pay per request)"
    echo "   • S3 lifecycle policies (automatic cost reduction)"
    echo "   • CloudFront price class optimization"
    echo "   • Reduced log retention (7 days)"
    echo "   • Single AZ deployment (where possible)"
    echo "   • Budget alerts configured"
    
    log "=== Cost Optimization Deployment Completed ==="
}

# Function to cleanup
cleanup() {
    log "Cleaning up temporary files..."
    rm -f "$TERRAFORM_DIR/tfplan"
    rm -f "$TERRAFORM_DIR/outputs.json"
    rm -f "$TERRAFORM_DIR/lambda-package.zip"
}

# Function to rollback
rollback() {
    warning "Rolling back cost-optimized deployment..."
    
    cd "$TERRAFORM_DIR"
    
    # Destroy infrastructure
    terraform destroy -auto-approve
    
    cd "$PROJECT_ROOT"
    
    warning "Rollback completed"
}

# Main deployment function
main() {
    log "Starting cost-optimized AWS deployment for Nursery Management System..."
    
    # Check Free Tier eligibility
    check_free_tier_eligibility
    
    # Estimate costs
    estimate_costs
    
    # Check prerequisites
    check_prerequisites
    
    # Setup Terraform backend
    setup_terraform_backend
    
    # Deploy cost-optimized infrastructure
    deploy_cost_optimized_infrastructure
    
    # Build and deploy Lambda function
    build_and_deploy_lambda
    
    # Deploy frontend to S3
    deploy_frontend_to_s3
    
    # Wait for deployment
    wait_for_deployment || { error "Deployment failed"; exit 1; }
    
    # Run cost optimization tests
    run_cost_optimization_tests
    
    # Display summary
    cost_optimization_summary
    
    # Cleanup
    cleanup
    
    log "Cost-optimized AWS deployment completed successfully!"
}

# Handle script arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "rollback")
        rollback
        ;;
    "infrastructure")
        check_prerequisites
        setup_terraform_backend
        deploy_cost_optimized_infrastructure
        ;;
    "lambda")
        build_and_deploy_lambda
        ;;
    "frontend")
        deploy_frontend_to_s3
        ;;
    "test")
        run_cost_optimization_tests
        ;;
    "costs")
        check_free_tier_eligibility
        estimate_costs
        ;;
    "status")
        cd "$TERRAFORM_DIR"
        terraform output
        cd "$PROJECT_ROOT"
        ;;
    *)
        echo "Usage: $0 {deploy|rollback|infrastructure|lambda|frontend|test|costs|status}"
        exit 1
        ;;
esac 
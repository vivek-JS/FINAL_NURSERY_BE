#!/bin/bash

# AWS Deployment Script for Nursery Management System
# This script automates the complete AWS deployment process

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TERRAFORM_DIR="$SCRIPT_DIR/terraform"
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
    
    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured"
        exit 1
    fi
    
    # Check if terraform.tfvars exists
    if [ ! -f "$TERRAFORM_DIR/terraform.tfvars" ]; then
        error "terraform.tfvars not found. Please copy terraform.tfvars.example and configure it."
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

# Function to deploy infrastructure with Terraform
deploy_infrastructure() {
    log "Deploying AWS infrastructure..."
    
    cd "$TERRAFORM_DIR"
    
    # Initialize Terraform
    terraform init
    
    # Plan deployment
    log "Planning Terraform deployment..."
    terraform plan -out=tfplan
    
    # Apply deployment
    log "Applying Terraform deployment..."
    terraform apply tfplan
    
    # Get outputs
    log "Getting deployment outputs..."
    terraform output -json > outputs.json
    
    # Extract important values
    ECR_REPO_URL=$(terraform output -raw ecr_repository_url)
    CLUSTER_NAME=$(terraform output -raw ecs_cluster_name)
    SERVICE_NAME=$(terraform output -raw ecs_service_name)
    APP_URL=$(terraform output -raw app_url)
    
    log "Infrastructure deployed successfully"
    log "ECR Repository: $ECR_REPO_URL"
    log "ECS Cluster: $CLUSTER_NAME"
    log "ECS Service: $SERVICE_NAME"
    log "Application URL: $APP_URL"
    
    cd "$PROJECT_ROOT"
}

# Function to build and push Docker image
build_and_push_image() {
    log "Building and pushing Docker image..."
    
    # Get ECR repository URL from Terraform output
    cd "$TERRAFORM_DIR"
    ECR_REPO_URL=$(terraform output -raw ecr_repository_url)
    cd "$PROJECT_ROOT"
    
    # Login to ECR
    aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REPO_URL"
    
    # Build Docker image
    log "Building Docker image..."
    docker build -f deployment/Dockerfile -t "$ECR_REPO_URL:latest" .
    
    # Push to ECR
    log "Pushing Docker image to ECR..."
    docker push "$ECR_REPO_URL:latest"
    
    log "Docker image pushed successfully"
}

# Function to update ECS service
update_ecs_service() {
    log "Updating ECS service..."
    
    cd "$TERRAFORM_DIR"
    CLUSTER_NAME=$(terraform output -raw ecs_cluster_name)
    SERVICE_NAME=$(terraform output -raw ecs_service_name)
    cd "$PROJECT_ROOT"
    
    # Force new deployment
    aws ecs update-service --cluster "$CLUSTER_NAME" --service "$SERVICE_NAME" --force-new-deployment --region "$AWS_REGION"
    
    log "ECS service update initiated"
}

# Function to wait for deployment
wait_for_deployment() {
    log "Waiting for deployment to complete..."
    
    cd "$TERRAFORM_DIR"
    CLUSTER_NAME=$(terraform output -raw ecs_cluster_name)
    SERVICE_NAME=$(terraform output -raw ecs_service_name)
    APP_URL=$(terraform output -raw app_url)
    cd "$PROJECT_ROOT"
    
    # Wait for ECS service to be stable
    log "Waiting for ECS service to be stable..."
    aws ecs wait services-stable --cluster "$CLUSTER_NAME" --services "$SERVICE_NAME" --region "$AWS_REGION"
    
    # Wait for health check to pass
    log "Waiting for health check to pass..."
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f "$APP_URL/health" >/dev/null 2>&1; then
            log "Health check passed"
            break
        fi
        
        info "Health check attempt $attempt/$max_attempts failed, retrying in 30 seconds..."
        sleep 30
        ((attempt++))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        error "Health check failed after $max_attempts attempts"
        return 1
    fi
}

# Function to run security tests
run_security_tests() {
    log "Running security tests..."
    
    cd "$TERRAFORM_DIR"
    APP_URL=$(terraform output -raw app_url)
    cd "$PROJECT_ROOT"
    
    # Test SSL configuration
    log "Testing SSL configuration..."
    if command -v ssl-checker &> /dev/null; then
        ssl-checker "$APP_URL" || warning "SSL check failed"
    fi
    
    # Test security headers
    log "Testing security headers..."
    SECURITY_HEADERS=$(curl -I "$APP_URL/api/v1/user/login" 2>/dev/null | grep -E "(Strict-Transport-Security|X-Frame-Options|X-Content-Type-Options|X-XSS-Protection)" || true)
    
    if [ -n "$SECURITY_HEADERS" ]; then
        log "Security headers are present"
    else
        warning "Some security headers may be missing"
    fi
    
    # Test rate limiting
    log "Testing rate limiting..."
    for i in {1..5}; do
        curl -s -o /dev/null -w "%{http_code}" "$APP_URL/api/v1/user/login" || true
        echo
    done
    
    log "Security tests completed"
}

# Function to display deployment summary
deployment_summary() {
    log "=== AWS Deployment Summary ==="
    
    cd "$TERRAFORM_DIR"
    terraform output deployment_summary
    cd "$PROJECT_ROOT"
    
    log "=== Deployment Completed Successfully ==="
}

# Function to cleanup
cleanup() {
    log "Cleaning up temporary files..."
    rm -f "$TERRAFORM_DIR/tfplan"
    rm -f "$TERRAFORM_DIR/outputs.json"
}

# Function to rollback
rollback() {
    warning "Rolling back deployment..."
    
    cd "$TERRAFORM_DIR"
    
    # Destroy infrastructure
    terraform destroy -auto-approve
    
    cd "$PROJECT_ROOT"
    
    warning "Rollback completed"
}

# Main deployment function
main() {
    log "Starting AWS deployment for Nursery Management System..."
    
    # Check prerequisites
    check_prerequisites
    
    # Setup Terraform backend
    setup_terraform_backend
    
    # Deploy infrastructure
    deploy_infrastructure
    
    # Build and push Docker image
    build_and_push_image
    
    # Update ECS service
    update_ecs_service
    
    # Wait for deployment
    wait_for_deployment || { error "Deployment failed"; exit 1; }
    
    # Run security tests
    run_security_tests
    
    # Display summary
    deployment_summary
    
    # Cleanup
    cleanup
    
    log "AWS deployment completed successfully!"
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
        deploy_infrastructure
        ;;
    "application")
        build_and_push_image
        update_ecs_service
        wait_for_deployment
        ;;
    "test")
        run_security_tests
        ;;
    "status")
        cd "$TERRAFORM_DIR"
        terraform output deployment_summary
        cd "$PROJECT_ROOT"
        ;;
    *)
        echo "Usage: $0 {deploy|rollback|infrastructure|application|test|status}"
        exit 1
        ;;
esac 
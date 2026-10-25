#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>
int main(int argc,char **argv){pid_t pid=argc==2?(pid_t)strtol(argv[1],NULL,10):getpid();struct proc_bsdinfo info;if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info)){perror("proc_pidinfo");return 1;}char path[PROC_PIDPATHINFO_MAXSIZE];if(proc_pidpath(pid,path,sizeof(path))<=0){perror("proc_pidpath");return 1;}struct timeval boot;size_t size=sizeof(boot);int mib[2]={CTL_KERN,KERN_BOOTTIME};if(sysctl(mib,2,&boot,&size,NULL,0)){perror("sysctl");return 1;}printf("{\"processId\":%d,\"startTime\":\"%llu.%06llu\",\"bootId\":\"%lld.%06d\",\"executable\":\"",pid,(unsigned long long)info.pbi_start_tvsec,(unsigned long long)info.pbi_start_tvusec,(long long)boot.tv_sec,boot.tv_usec);for(char*c=path;*c;c++){if(*c=='\\'||*c=='\"')putchar('\\');putchar(*c);}puts("\"}");return 0;}

#include "mupdf/fitz.h"
#include <stdio.h>
#include <string.h>
int main(void) {
    unsigned char malformed[] = {1,0,4,1,0,1,1,1,5,'A'};
    fz_context *ctx=fz_new_context(NULL,NULL,0);
    fz_buffer *buffer=fz_new_buffer_from_copied_data(ctx,malformed,sizeof(malformed));
    fz_buffer *result=NULL;
    int gid=0,caught=0;
    fz_var(result);fz_var(caught);
    fz_try(ctx) { result=fz_subset_cff_for_gids(ctx,buffer,&gid,1,0,0); }
    fz_catch(ctx) { caught=!strcmp(fz_caught_message(ctx),"Truncated index"); }
    printf("CFF_index_offset_plus_length_rejected: %s\n",caught?"PASS":"FAIL");
    fz_drop_buffer(ctx,result);fz_drop_buffer(ctx,buffer);fz_drop_context(ctx);
    return caught?0:1;
}

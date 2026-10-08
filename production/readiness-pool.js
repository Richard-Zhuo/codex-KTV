// Only readiness reads use this port. Business transaction deadlines remain owned by the ledger.
export function readinessPool(pool,timeout=2000) {
 return {async getConnection(){
  const connection=await pool.getConnection();
  const run=method=>async(sql,values)=>{
   try{return await connection[method](typeof sql==='string'?{sql,timeout}:{...sql,timeout},values);}
   catch(error){connection.destroy();throw error;}
  };
  return {query:run('query'),execute:run('execute'),release:()=>connection.release()};
 }};
}
